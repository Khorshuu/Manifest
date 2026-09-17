import { Parser } from "htmlparser2";
import { cleanText, labelKey } from "./normalize";

/**
 * Reading product information out of a document, deterministically (D-075).
 *
 * Three readers, no AI:
 *  - schema.org Product JSON-LD (name, brand, GTINs, MPN, model, colour,
 *    material, weight, dimensions, additionalProperty);
 *  - two-cell table rows and definition lists (label → value);
 *  - "Label: value" lines in plain text.
 *
 * Scripts are never executed and their text is never read, except JSON-LD,
 * which is parsed as data with size and depth limits. Every pair keeps where
 * it came from and the exact text, which becomes the evidence excerpt.
 */

export type ExtractedPair = {
  label: string;
  value: string;
  unit: string | null;
  method: "structured_data" | "html_table" | "html_text";
  locator: string;
  excerpt: string;
};

export type ExtractedIdentity = {
  names: string[];
  brands: string[];
  gtins: string[];
  mpns: string[];
  models: string[];
};

export type Extraction = {
  pairs: ExtractedPair[];
  identity: ExtractedIdentity;
  /** JSON-LD Product objects as found, for the stored document. */
  structuredData: unknown[];
  /** Visible text, collapsed, for the stored document. */
  text: string;
};

const MAX_PAIRS = 300;
const MAX_JSON_LD_BYTES = 200_000;
const MAX_TEXT = 500_000;
const MAX_LABEL = 80;
const MAX_VALUE = 400;

/** UN/CEFACT unit codes schema.org uses, mapped to units the registry reads. */
const UNIT_CODES: Record<string, string> = {
  GRM: "g",
  KGM: "kg",
  LBR: "lb",
  ONZ: "oz",
  MGM: "mg",
  MMT: "mm",
  CMT: "cm",
  MTR: "m",
  INH: "in",
  FOT: "ft",
  MLT: "mL",
  LTR: "L",
  SEC: "s",
  MIN: "min",
  HUR: "h",
  WTT: "W",
  KWT: "kW",
  VLT: "V",
  AMP: "A",
  HTZ: "Hz",
  KHZ: "kHz",
  MHZ: "MHz",
  A86: "GHz",
  E34: "GB",
  E35: "TB",
  "4L": "MB",
  MAH: "mAh",
  CEL: "°C",
  FAH: "°F",
  P1: "%",
};

const IDENTITY_LABELS: Record<string, keyof ExtractedIdentity> = {
  "model": "models",
  "model number": "models",
  "model no": "models",
  "model name": "names",
  "mpn": "mpns",
  "manufacturer part number": "mpns",
  "part number": "mpns",
  "gtin": "gtins",
  "upc": "gtins",
  "ean": "gtins",
  "barcode": "gtins",
  "brand": "brands",
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return cleanText(String(value)) || null;
  if (value && typeof value === "object" && "name" in value) return textOf((value as { name: unknown }).name);
  return null;
}

function quantityOf(value: unknown): { value: string; unit: string | null } | null {
  if (typeof value === "string" || typeof value === "number") {
    const text = textOf(value);
    return text ? { value: text, unit: null } : null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const amount = textOf(record.value);
    if (!amount) return null;
    const code = typeof record.unitCode === "string" ? UNIT_CODES[record.unitCode.toUpperCase()] ?? null : null;
    const unit = code ?? textOf(record.unitText);
    return { value: amount, unit };
  }
  return null;
}

function depthOk(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (Array.isArray(value)) return value.every((entry) => depthOk(entry, depth + 1));
  if (value && typeof value === "object") return Object.values(value).every((entry) => depthOk(entry, depth + 1));
  return true;
}

function productObjects(root: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || found.length >= 10) return;
    if (Array.isArray(node)) return node.forEach((entry) => visit(entry, depth + 1));
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const types = ([] as unknown[]).concat(record["@type"] ?? []).map(String);
    if (types.some((type) => ["Product", "ProductModel", "IndividualProduct", "ProductGroup"].includes(type))) found.push(record);
    if (record["@graph"]) visit(record["@graph"], depth + 1);
  };
  visit(root, 0);
  return found;
}

function readJsonLd(scripts: string[], pairs: ExtractedPair[], identity: ExtractedIdentity, structured: unknown[]) {
  scripts.forEach((script, scriptIndex) => {
    if (script.length > MAX_JSON_LD_BYTES) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(script);
    } catch {
      return;
    }
    if (!depthOk(parsed)) return;
    for (const product of productObjects(parsed)) {
      structured.push(product);
      const locator = (field: string) => `json-ld[${scriptIndex}] Product.${field}`;
      const add = (label: string, raw: unknown, field: string) => {
        const quantity = quantityOf(raw);
        if (!quantity || pairs.length >= MAX_PAIRS) return;
        const value = clip(quantity.value, MAX_VALUE);
        pairs.push({
          label,
          value,
          unit: quantity.unit,
          method: "structured_data",
          locator: locator(field),
          excerpt: clip(`"${field}": ${JSON.stringify(raw)}`, 1000),
        });
      };

      const name = textOf(product.name);
      if (name) identity.names.push(name);
      const brand = textOf(product.brand);
      if (brand) {
        identity.brands.push(brand);
        add("Brand", brand, "brand");
      }
      for (const field of ["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "isbn"]) {
        const value = textOf(product[field]);
        if (value) identity.gtins.push(value);
      }
      const mpn = textOf(product.mpn);
      if (mpn) identity.mpns.push(mpn);
      const model = textOf(product.model);
      if (model) identity.models.push(model);

      add("Colour", product.color, "color");
      add("Material", product.material, "material");
      add("Item weight", product.weight, "weight");
      add("Height", product.height, "height");
      add("Width", product.width, "width");
      add("Depth", product.depth, "depth");
      add("Size", product.size, "size");
      add("Country of origin", product.countryOfOrigin, "countryOfOrigin");
      add("Released", product.releaseDate, "releaseDate");

      const properties = ([] as unknown[]).concat(product.additionalProperty ?? []);
      properties.forEach((property, index) => {
        if (!property || typeof property !== "object") return;
        const record = property as Record<string, unknown>;
        const label = textOf(record.name);
        const quantity = quantityOf(record);
        if (!label || !quantity || pairs.length >= MAX_PAIRS) return;
        pairs.push({
          label: clip(label, MAX_LABEL),
          value: clip(quantity.value, MAX_VALUE),
          unit: quantity.unit,
          method: "structured_data",
          locator: locator(`additionalProperty[${index}]`),
          excerpt: clip(JSON.stringify(property), 1000),
        });
      });
    }
  });
}

/** A label → value pair noticed in markup or text, and any identity it names. */
function addPair(pairs: ExtractedPair[], identity: ExtractedIdentity, pair: Omit<ExtractedPair, "unit">) {
  const label = cleanText(pair.label).replace(/[:\s]+$/, "");
  const value = cleanText(pair.value);
  if (!label || !value || label.length > MAX_LABEL || pairs.length >= MAX_PAIRS) return;
  const kind = IDENTITY_LABELS[labelKey(label)];
  if (kind) identity[kind].push(clip(value, 120));
  pairs.push({ ...pair, label, value: clip(value, MAX_VALUE), unit: null });
}

export function extractHtml(html: string): Extraction {
  const pairs: ExtractedPair[] = [];
  const identity: ExtractedIdentity = { names: [], brands: [], gtins: [], mpns: [], models: [] };
  const structured: unknown[] = [];
  const jsonLd: string[] = [];
  const text: string[] = [];
  let textLength = 0;

  const stack: string[] = [];
  let scriptKind: "json-ld" | "other" | null = null;
  let scriptBuffer = "";
  let tableIndex = -1;
  let rowIndex = -1;
  let cells: string[] | null = null;
  let cellBuffer: string | null = null;
  let dlIndex = -1;
  let dtBuffer: string | null = null;
  let pendingTerm: string | null = null;
  let ddBuffer: string | null = null;

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        stack.push(name);
        if (name === "script") {
          scriptKind = (attributes.type ?? "").toLowerCase().includes("ld+json") ? "json-ld" : "other";
          scriptBuffer = "";
        } else if (name === "table") {
          tableIndex += 1;
          rowIndex = -1;
        } else if (name === "tr") {
          rowIndex += 1;
          cells = [];
        } else if ((name === "td" || name === "th") && cells) {
          cellBuffer = "";
        } else if (name === "dl") {
          dlIndex += 1;
        } else if (name === "dt") {
          dtBuffer = "";
        } else if (name === "dd") {
          ddBuffer = "";
        } else if (name === "br" || name === "p" || name === "li" || name === "div") {
          text.push("\n");
        }
      },
      ontext(chunk) {
        if (scriptKind === "json-ld") {
          scriptBuffer += chunk;
          return;
        }
        if (scriptKind === "other" || stack.includes("style") || stack.includes("noscript") || stack.includes("template")) return;
        if (cellBuffer !== null) cellBuffer += chunk;
        if (dtBuffer !== null) dtBuffer += chunk;
        if (ddBuffer !== null) ddBuffer += chunk;
        if (textLength < MAX_TEXT) {
          text.push(chunk);
          textLength += chunk.length;
        }
      },
      onclosetag(name) {
        stack.pop();
        if (name === "script") {
          if (scriptKind === "json-ld") jsonLd.push(scriptBuffer);
          scriptKind = null;
        } else if ((name === "td" || name === "th") && cells && cellBuffer !== null) {
          cells.push(cellBuffer);
          cellBuffer = null;
        } else if (name === "tr" && cells) {
          if (cells.length === 2) {
            addPair(pairs, identity, {
              label: cells[0],
              value: cells[1],
              method: "html_table",
              locator: `table[${tableIndex}] row[${rowIndex}]`,
              excerpt: clip(`${cleanText(cells[0])}: ${cleanText(cells[1])}`, 1000),
            });
          }
          cells = null;
          text.push("\n");
        } else if (name === "dt" && dtBuffer !== null) {
          pendingTerm = dtBuffer;
          dtBuffer = null;
        } else if (name === "dd" && ddBuffer !== null) {
          if (pendingTerm !== null) {
            addPair(pairs, identity, {
              label: pendingTerm,
              value: ddBuffer,
              method: "html_table",
              locator: `dl[${dlIndex}] ${cleanText(pendingTerm).slice(0, 40)}`,
              excerpt: clip(`${cleanText(pendingTerm)}: ${cleanText(ddBuffer)}`, 1000),
            });
            pendingTerm = null;
          }
          ddBuffer = null;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html.length > 5_000_000 ? html.slice(0, 5_000_000) : html);
  parser.end();

  readJsonLd(jsonLd, pairs, identity, structured);
  return { pairs, identity: dedupeIdentity(identity), structuredData: structured, text: collapse(text.join(" ")) };
}

export function extractText(content: string): Extraction {
  const pairs: ExtractedPair[] = [];
  const identity: ExtractedIdentity = { names: [], brands: [], gtins: [], mpns: [], models: [] };
  const lines = content.slice(0, MAX_TEXT).split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = /^\s*([^:\t]{1,80})[:\t]\s*(.+?)\s*$/.exec(line);
    if (!match) return;
    addPair(pairs, identity, {
      label: match[1],
      value: match[2],
      method: "html_text",
      locator: `line ${index + 1}`,
      excerpt: clip(line.trim(), 1000),
    });
  });
  return { pairs, identity: dedupeIdentity(identity), structuredData: [], text: collapse(content.slice(0, MAX_TEXT)) };
}

export function extractJson(content: string): Extraction {
  const pairs: ExtractedPair[] = [];
  const identity: ExtractedIdentity = { names: [], brands: [], gtins: [], mpns: [], models: [] };
  const structured: unknown[] = [];
  readJsonLd([content], pairs, identity, structured);
  return { pairs, identity: dedupeIdentity(identity), structuredData: structured, text: collapse(content.slice(0, MAX_TEXT)) };
}

export function extractDocument(content: string, contentType: string): Extraction {
  if (contentType === "text/html" || contentType === "application/xhtml+xml") return extractHtml(content);
  if (contentType === "application/json" || contentType === "application/ld+json") return extractJson(content);
  return extractText(content);
}

function collapse(text: string): string {
  return text.replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function dedupeIdentity(identity: ExtractedIdentity): ExtractedIdentity {
  const unique = (values: string[]) => [...new Set(values.map((value) => cleanText(value)).filter(Boolean))].slice(0, 20);
  return {
    names: unique(identity.names),
    brands: unique(identity.brands),
    gtins: unique(identity.gtins),
    mpns: unique(identity.mpns),
    models: unique(identity.models),
  };
}
