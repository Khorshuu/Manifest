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

/*
 * The two layouts manufacturers actually publish specifications in, besides a
 * `<table>` and a `<dl>`.
 *
 * A specification table stopped being a `<table>` some years ago. The pages
 * this pipeline exists to read put the same label → value information in one
 * of two shapes, and neither of them is markup a table reader recognises:
 *
 *  - a heading and the block that follows it — `<h3>Chip</h3><ul><li>A13
 *    Bionic chip</li>…</ul>`, or `<h4>Impedance:</h4><p>48 Ω (1 kHz)</p>`;
 *  - a row built from two elements — `<div><div>Weight</div><div>665g</div>
 *    </div>`, the layout a CSS grid produces.
 *
 * Both are read structurally, not by guessing at wording, so nothing here is
 * specific to one manufacturer or one kind of product. Two rules keep the
 * noise out: a block whose text is mostly link text is navigation rather than
 * information and is skipped, and a line inside such a block that is itself
 * "Label: value" is read as its own pair rather than folded into the heading's.
 *
 * As everywhere else in the pipeline, a pair is a proposal: it becomes a claim
 * only if an attribute already names its label, and otherwise becomes a label
 * a person is asked about.
 */
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Tags that end an inline run — used to tell a leaf cell from a container. */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "ul",
]);

/** Text kept per element while it is open. Enough for a label or a value. */
const MAX_FRAME_TEXT = 4_000;
/** Blocks collected under one heading before the rest are ignored. */
const MAX_HEADING_PARTS = 40;
/** Above this share of link text, a block is navigation, not information. */
const LINK_TEXT_SHARE = 0.5;
/** A "Label: value" line inside a block, read as its own pair. */
const LABELLED_LINE = /^\s*([^:]{1,60}?)\s*:\s+(\S.*)$/;

type Frame = {
  tag: string;
  text: string;
  /** Characters of this element's text that were inside a link. */
  linkChars: number;
  /** False while the element has only inline children: a cell, not a container. */
  hasBlockChild: boolean;
  elementChildren: number;
  /** The first two element children, which is all a two-cell row needs. */
  cellsSeen: { text: string; leaf: boolean; linkChars: number }[];
  /** The heading this element has passed, and the blocks since. */
  label: string | null;
  labelLinkChars: number;
  parts: string[];
  /**
   * True once this element's own heading produced pairs. Its text is then not
   * folded into an outer heading's value as well, which is what would
   * otherwise report every specification twice — once for the section that
   * states it and once for the section that contains that section.
   */
  consumed: boolean;
};

function newFrame(tag: string): Frame {
  return {
    tag,
    text: "",
    linkChars: 0,
    hasBlockChild: false,
    elementChildren: 0,
    cellsSeen: [],
    label: null,
    labelLinkChars: 0,
    parts: [],
    consumed: false,
  };
}

function appendFrameText(frame: Frame, chunk: string): void {
  if (frame.text.length >= MAX_FRAME_TEXT) return;
  frame.text += chunk;
}

/**
 * A footnote reference, which specification pages hang off labels and
 * occasionally set beside them: "Supported Codec 4)". It is never a value, and
 * as part of a label it only produces a second spelling of an attribute that
 * already exists.
 */
const FOOTNOTE_MARK = /^\(?\d{1,2}\)$/;
const TRAILING_FOOTNOTE = /\s*\(?\d{1,2}\)$/;

/** A label → value pair noticed in markup or text, and any identity it names. */
function addPair(pairs: ExtractedPair[], identity: ExtractedIdentity, pair: Omit<ExtractedPair, "unit">) {
  const label = cleanText(pair.label).replace(/[:\s]+$/, "").replace(TRAILING_FOOTNOTE, "");
  const value = cleanText(pair.value);
  if (FOOTNOTE_MARK.test(value)) return;
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

  const frames: Frame[] = [];
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

  const inside = (tag: string) => frames.some((frame) => frame.tag === tag);
  /*
   * What the document calls itself. Until now a name was only ever read out of
   * JSON-LD, so a page without it carried no name at all and the identity
   * check had nothing to compare — which is most manufacturer documentation.
   * The title and the headline are what the page says it is about; whether
   * that agrees with the product is still `identityVerdict`'s decision.
   */
  let documentNames = 0;

  /** Emits the pairs a heading and the blocks under it produced. */
  const flushHeading = (frame: Frame) => {
    const heading = frame.label;
    const parts = frame.parts;
    const linkChars = frame.labelLinkChars;
    frame.label = null;
    frame.parts = [];
    frame.labelLinkChars = 0;
    if (heading === null) return;

    const label = cleanText(heading).replace(/[:\s]+$/, "");
    if (!label || label.length > MAX_LABEL || !/\p{L}/u.test(label)) return;

    // What a heading's own block already reported is not folded into the
    // heading above it as well.
    const emit = (pair: Omit<ExtractedPair, "unit">) => {
      addPair(pairs, identity, pair);
      frame.consumed = true;
    };

    const lines = parts
      .join("\n")
      .split("\n")
      .map((line) => cleanText(line))
      .filter(Boolean);
    const total = lines.join(" ").length;
    if (total === 0) return;
    // Mostly link text: a menu or a table of contents, not a specification.
    if (linkChars / total > LINK_TEXT_SHARE) return;

    const folded: string[] = [];
    for (const line of lines) {
      const labelled = LABELLED_LINE.exec(line);
      if (labelled && /\p{L}/u.test(labelled[1])) {
        emit({
          label: labelled[1],
          value: labelled[2],
          method: "html_text",
          locator: `${label.slice(0, 40)} / ${cleanText(labelled[1]).slice(0, 40)}`,
          excerpt: clip(line, 1000),
        });
        continue;
      }
      folded.push(line);
    }
    if (folded.length === 0) return;
    const value = folded.join("; ");
    emit({
      label,
      value,
      method: "html_text",
      locator: `heading "${label.slice(0, 40)}"`,
      excerpt: clip(`${label}: ${value}`, 1000),
    });
  };

  /** Emits the pair a two-element layout row produced. */
  const flushRow = (frame: Frame) => {
    if (frame.elementChildren !== 2 || frame.cellsSeen.length !== 2) return;
    if (frame.tag === "tr" || frame.tag === "dl" || HEADING_TAGS.has(frame.tag)) return;
    const [first, second] = frame.cellsSeen;
    if (!first.leaf || !second.leaf) return;
    const label = cleanText(first.text).replace(/[:\s]+$/, "");
    const value = cleanText(second.text);
    if (!label || !value || label === value) return;
    if (label.length > MAX_LABEL || !/\p{L}/u.test(label)) return;
    if ((first.linkChars + second.linkChars) / (label.length + value.length) > LINK_TEXT_SHARE) return;
    addPair(pairs, identity, {
      label,
      value,
      method: "html_table",
      locator: `${frame.tag} row "${label.slice(0, 40)}"`,
      excerpt: clip(`${label}: ${value}`, 1000),
    });
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const parent = frames[frames.length - 1];
        if (parent && (name === "br" || name === "p" || name === "li" || name === "div" || name === "tr")) {
          appendFrameText(parent, "\n");
        }
        frames.push(newFrame(name));
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
        if (scriptKind === "other" || inside("style") || inside("noscript") || inside("template")) return;
        if (cellBuffer !== null) cellBuffer += chunk;
        if (dtBuffer !== null) dtBuffer += chunk;
        if (ddBuffer !== null) ddBuffer += chunk;
        const frame = frames[frames.length - 1];
        if (frame) appendFrameText(frame, chunk);
        if (textLength < MAX_TEXT) {
          text.push(chunk);
          textLength += chunk.length;
        }
      },
      onclosetag(name) {
        const frame = frames.pop();
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

        if (!frame) return;
        if ((frame.tag === "title" || frame.tag === "h1") && documentNames < 4) {
          const name = cleanText(frame.text);
          if (name) {
            identity.names.push(clip(name, 200));
            documentNames += 1;
          }
        }
        // A heading still open inside this element belongs to this element.
        flushHeading(frame);
        flushRow(frame);

        const parent = frames[frames.length - 1];
        if (!parent) return;
        const linkChars = frame.linkChars + (frame.tag === "a" ? frame.text.length : 0);
        parent.elementChildren += 1;
        if (parent.cellsSeen.length < 2) {
          parent.cellsSeen.push({ text: frame.text, leaf: !frame.hasBlockChild, linkChars });
        }
        parent.linkChars += linkChars;
        if (BLOCK_TAGS.has(frame.tag)) parent.hasBlockChild = true;
        appendFrameText(parent, frame.text);

        if (HEADING_TAGS.has(frame.tag)) {
          flushHeading(parent);
          parent.label = frame.text;
        } else if (
          parent.label !== null &&
          !frame.consumed &&
          frame.text.trim() &&
          parent.parts.length < MAX_HEADING_PARTS
        ) {
          parent.parts.push(frame.text);
          parent.labelLinkChars += linkChars;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html.length > 5_000_000 ? html.slice(0, 5_000_000) : html);
  parser.end();
  // Anything still open when the document ended.
  for (const frame of frames) flushHeading(frame);

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
