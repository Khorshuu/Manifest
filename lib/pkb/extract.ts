import { Parser } from "htmlparser2";
import { identityLabelKind, type IdentityLabelKind } from "./identity-labels";
import { cleanText, labelKey, removeStorageNoise, removeStorageNoiseDeep } from "./normalize";

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
  method: "structured_data" | "html_table" | "html_text" | "ai_assisted";
  locator: string;
  excerpt: string;
  /**
   * "variant" when the pair describes the one version of the product the page
   * is showing — the selected colour or shade — rather than every version it
   * sells (D-123). Such a pair is only used when that version is this product.
   */
  scope?: "variant";
  /** What an intelligent reading suggested the statement is (D-123); for the person reviewing only. */
  suggestion?: { kind: string; meaning: string | null };
};

export type ExtractedIdentity = {
  names: string[];
  brands: string[];
  gtins: string[];
  mpns: string[];
  models: string[];
  /**
   * Stock-keeping units a Product or one of its Offers declares in
   * structured data. On a manufacturer's own page this is the
   * manufacturer's code for the item, which is why it is compared as a model
   * identifier; a label reading "SKU" in a table is recorded here too.
   */
  skus?: string[];
  /**
   * The identifiers each Offer declared, kept with the Product it belongs to.
   * Shopify and most shop platforms put the GTIN and SKU on the Offer — one
   * per colour or size — rather than on the Product, and the flat lists above
   * cannot say which identifiers arrived together.
   */
  offers?: ExtractedOffer[];
  /**
   * The versions a page sells, when its structured data declares a product
   * family — a ProductGroup's `hasVariant`, one entry per shade, colour or
   * size (D-123). Their identifiers are kept here, apart from the flat lists
   * above, so a page selling forty shades is not read as one product carrying
   * forty GTINs.
   */
  variants?: ExtractedVariant[];
  /** Which of `variants` the page is showing, when that can be told. */
  displayedVariant?: number | null;
};

export type ExtractedVariant = {
  name: string | null;
  /**
   * What sets this version apart, as the page names it: the part of its name
   * after the family's name ("Black"), and any colour, size or pattern it
   * declares.
   */
  distinguishing: string[];
  sku: string | null;
  gtins: string[];
  url: string | null;
};

export type ExtractedOffer = {
  /** Which Product object on the page the offer belongs to, in document order. */
  product: number;
  productName: string | null;
  sku: string | null;
  mpn: string | null;
  gtins: string[];
};

export type ExtractedNarrative = {
  /** The section's heading, as the page writes it: "DETAILS", "How to use". */
  heading: string;
  /** The section's statements, whole, one per line. */
  text: string;
  locator: string;
};

export type Extraction = {
  pairs: ExtractedPair[];
  identity: ExtractedIdentity;
  /** JSON-LD Product objects as found, for the stored document. */
  structuredData: unknown[];
  /** Visible text, collapsed, for the stored document. */
  text: string;
  /**
   * Page sections written as prose (D-123). Not pairs: a heading over
   * paragraphs is where facts are, not an attribute. Kept whole for an
   * intelligent reader; the structured readers propose nothing from them.
   */
  narratives?: ExtractedNarrative[];
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

/**
 * Where a label the canonical identity list recognises is recorded. A
 * manufacturer or an ASIN is identity too, but neither is something a
 * document is matched on, so they are left out of the extracted identity.
 */
const IDENTITY_FIELD: Partial<Record<IdentityLabelKind, "names" | "brands" | "gtins" | "mpns" | "models" | "skus">> = {
  brand: "brands",
  name: "names",
  model: "models",
  mpn: "mpns",
  gtin: "gtins",
  sku: "skus",
};

const GTIN_FIELDS = ["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "isbn"] as const;

function emptyIdentity(): Required<ExtractedIdentity> {
  return { names: [], brands: [], gtins: [], mpns: [], models: [], skus: [], offers: [], variants: [], displayedVariant: null };
}

/** The address as compared: host, path and query, without scheme, fragment or a leading "www.". */
function comparableUrl(value: string | null, base?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base ?? "https://example.invalid");
    const query = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const search = query.length ? `?${query.map(([key, entry]) => `${key}=${entry}`).join("&")}` : "";
    const host = base && url.hostname === "example.invalid" ? "" : url.hostname.replace(/^www\./, "");
    return `${host}${url.pathname.replace(/\/+$/, "")}${search}`.toLowerCase();
  } catch {
    return null;
  }
}

/** A family member's name, less the family's own name: "… Hair Dye - Black" → "Black". */
function nameSuffix(name: string | null, groupName: string | null): string | null {
  if (!name || !groupName) return null;
  const folded = labelKey(name);
  const group = labelKey(groupName);
  if (!group || !folded.startsWith(group) || folded.length === group.length) return null;
  // The same number of words as the group's name are dropped from the original.
  const words = cleanText(name).split(" ");
  const groupWords = group.split(" ").length;
  let taken = 0;
  let index = 0;
  while (index < words.length && taken < groupWords) {
    if (labelKey(words[index])) taken += labelKey(words[index]).split(" ").length;
    index += 1;
  }
  const rest = words.slice(index).join(" ").replace(/^[\s,:;–—|/-]+/, "").trim();
  return rest || null;
}

/**
 * The versions a ProductGroup declares (D-123), and which of them the page is
 * showing: the one whose address is the address that was read, or failing
 * that the one whose SKU the page's own Product states.
 */
function readVariants(
  group: Record<string, unknown>,
  identity: Required<ExtractedIdentity>,
  context: { url?: string; displayedSkus: string[]; displayedUrls: string[] },
) {
  const groupName = textOf(group.name);
  const entries = ([] as unknown[]).concat(group.hasVariant ?? []).slice(0, 200);
  const base = context.url;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || identity.variants.length >= 200) continue;
    const record = entry as Record<string, unknown>;
    const name = textOf(record.name);
    const offers = offersOf(record);
    const url =
      (typeof offers[0]?.url === "string" ? (offers[0].url as string) : null) ??
      (typeof record.url === "string" ? record.url : null) ??
      (typeof record["@id"] === "string" ? (record["@id"] as string).replace(/#.*$/, "") : null);
    const declared = [textOf(record.color), textOf(record.size), textOf(record.pattern), textOf(record.material)].filter(
      (value): value is string => Boolean(value),
    );
    const suffix = nameSuffix(name, groupName);
    let absolute: string | null = null;
    try {
      absolute = url ? new URL(url, base ?? "https://example.invalid").toString() : null;
    } catch {
      absolute = null;
    }
    identity.variants.push({
      name,
      distinguishing: [...new Set([...(suffix ? [suffix] : []), ...declared])],
      sku: textOf(record.sku) ?? textOf(offers[0]?.sku),
      gtins: GTIN_FIELDS.map((field) => textOf(record[field])).filter((value): value is string => Boolean(value)),
      url: absolute,
    });
  }

  if (identity.displayedVariant !== null || identity.variants.length === 0) return;
  const wanted = new Set(
    [base ?? null, ...context.displayedUrls].map((value) => comparableUrl(value, base)).filter((value): value is string => Boolean(value)),
  );
  const byUrl = identity.variants.findIndex((variant) => {
    const key = comparableUrl(variant.url, base);
    return key !== null && wanted.has(key);
  });
  if (byUrl >= 0) {
    identity.displayedVariant = byUrl;
    return;
  }
  const skus = new Set(context.displayedSkus.map((sku) => labelKey(sku)));
  const bySku = identity.variants.findIndex((variant) => variant.sku !== null && skus.has(labelKey(variant.sku)));
  if (bySku >= 0) identity.displayedVariant = bySku;
}

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

function typesOf(record: Record<string, unknown>): string[] {
  return ([] as unknown[]).concat(record["@type"] ?? []).map(String);
}

/**
 * The Offer objects one Product declares, including those inside an
 * AggregateOffer. Only the Product's own `offers` are read — never an offer
 * found elsewhere on the page — so an identifier is always attributed to the
 * product that stated it.
 */
function offersOf(product: Record<string, unknown>): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 3 || found.length >= 50) return;
    if (Array.isArray(node)) return node.forEach((entry) => visit(entry, depth + 1));
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const types = typesOf(record);
    if (types.includes("AggregateOffer")) return visit(record.offers, depth + 1);
    if (types.length === 0 || types.includes("Offer")) found.push(record);
  };
  visit(product.offers, 0);
  return found;
}

function readJsonLd(
  scripts: string[],
  pairs: ExtractedPair[],
  identity: Required<ExtractedIdentity>,
  structured: unknown[],
  options: { url?: string } = {},
) {
  let productIndex = -1;
  const groups: Record<string, unknown>[] = [];
  /** What the page's own (non-group) Products state: the version on show. */
  const displayedSkus: string[] = [];
  const displayedUrls: string[] = [];
  scripts.forEach((script, scriptIndex) => {
    if (script.length > MAX_JSON_LD_BYTES) return;
    let parsed: unknown;
    try {
      // Escaped noise ("​", "\u0000") only exists once parsed.
      parsed = removeStorageNoiseDeep(JSON.parse(script));
    } catch {
      return;
    }
    if (!depthOk(parsed)) return;
    for (const product of productObjects(parsed)) {
      productIndex += 1;
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
      if (typesOf(product).includes("ProductGroup")) {
        groups.push(product);
      } else {
        const ownSku = textOf(product.sku);
        if (ownSku) displayedSkus.push(ownSku);
        for (const offer of offersOf(product)) {
          if (typeof offer.url === "string") displayedUrls.push(offer.url);
          const offerSku = textOf(offer.sku);
          if (offerSku) displayedSkus.push(offerSku);
        }
      }
      const brand = textOf(product.brand);
      if (brand) {
        identity.brands.push(brand);
        add("Brand", brand, "brand");
      }
      for (const field of GTIN_FIELDS) {
        const value = textOf(product[field]);
        if (value) identity.gtins.push(value);
      }
      const mpn = textOf(product.mpn);
      if (mpn) identity.mpns.push(mpn);
      const model = textOf(product.model);
      if (model) identity.models.push(model);
      const sku = textOf(product.sku);
      if (sku) identity.skus.push(sku);

      for (const offer of offersOf(product)) {
        const offerSku = textOf(offer.sku);
        const offerMpn = textOf(offer.mpn);
        const offerGtins = GTIN_FIELDS.map((field) => textOf(offer[field])).filter((value): value is string => Boolean(value));
        if (!offerSku && !offerMpn && offerGtins.length === 0) continue;
        if (offerSku) identity.skus.push(offerSku);
        if (offerMpn) identity.mpns.push(offerMpn);
        identity.gtins.push(...offerGtins);
        if (identity.offers.length < 20) {
          identity.offers.push({ product: productIndex, productName: name, sku: offerSku, mpn: offerMpn, gtins: offerGtins });
        }
      }

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
  for (const group of groups) readVariants(group, identity, { url: options.url, displayedSkus, displayedUrls });
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
/** A numbered step, tip or note: a position in a sequence, never an attribute. */
const SEQUENCE_LABEL = /^(?:step|tip|note|stage|phase)\s*\d{1,2}$/i;
/**
 * The option a variant picker shows as chosen: "Color — Black (010)",
 * "Size: M". Read only from a `<label>`, which is where every shop platform
 * prints it, and only as a short name and a short value.
 */
const SELECTED_OPTION = /^([\p{L}][\p{L} ]{0,30}?)\s*[—–:]\s*(\S.{0,79})$/u;

/*
 * Page furniture a specification is never in (D-119).
 *
 * A manufacturer's product page is mostly not specification: a navigation
 * menu, a newsletter form, the reviews, a "perfect pairing" banner selling a
 * different product, a basket drawer. Each of those is built from the same
 * headings and two-element rows the readers above exist to read, so each of
 * them used to become a pair — "Nathan k.: 5/5", "You're on the List!:
 * Close", "GMP 2 Gaming Mouse Pad: Aim for success…". A person was then asked
 * to name every one of them as an attribute.
 *
 * What marks furniture is structural and shared by every shop platform, so
 * nothing here names a manufacturer:
 *
 *  - the element says what it is: `<nav>`, `<footer>`, `<form>`, `<button>`,
 *    or a navigation/banner/contentinfo/search/menu role;
 *  - its class or id says what it is, as a whole hyphen- or underscore-
 *    separated word: `reviews`, `newsletter`, `cart`, `related`…;
 *  - a button's text is an action, never a value;
 *  - a block that holds a button or a "Shop now" link is selling something,
 *    and it is not this page's product's specification.
 *
 * A dialog, a modal and a drawer are deliberately not on the list: a
 * manufacturer's "full specifications" panel is very often one of them.
 *
 * A table row inside none of these is read exactly as before: nothing on this
 * list can remove a technical row from the product's own specification table.
 */
const FURNITURE_TAGS = new Set(["nav", "footer", "form", "button", "select", "option", "textarea"]);
const FURNITURE_ROLES = new Set(["navigation", "banner", "contentinfo", "search", "menu", "menubar"]);
const FURNITURE_WORDS =
  /(?:^|[-_])(?:reviews?|testimonials?|ratings?|newsletters?|subscribe|subscription|cross-?sells?|up-?sells?|related|recommend(?:ed|ations?)?|breadcrumbs?|cookies?|consent|mega-?menu|navbar|navigation|footer|cart|minicart)(?:[-_]|$)/i;

/** Elements a person acts on; a block holding one is not a statement. */
const INTERACTIVE_TAGS = new Set(["button", "input", "select", "textarea"]);

function isFurniture(tag: string, attributes: Record<string, string>): boolean {
  if (FURNITURE_TAGS.has(tag)) return true;
  if (FURNITURE_ROLES.has((attributes.role ?? "").toLowerCase())) return true;
  const names = `${attributes.class ?? ""} ${attributes.id ?? ""}`.split(/\s+/).filter(Boolean);
  return names.some((name) => FURNITURE_WORDS.test(name));
}

/** An action, not information: a whole label or value reading one of these is dropped. */
const CALL_TO_ACTION =
  /^(?:add to (?:cart|bag|basket|wish ?list)|buy(?: it)? now|shop now|shop all|order now|pre-?order now|close|learn more|read more|see more|see details|view (?:details|more|all|product)|discover more|explore|subscribe|sign up|notify me(?: when available)?|sold out|choose options|select options|quick (?:view|shop|add)|continue shopping|checkout|compare)[.!]?$/i;

/** A review's rating: "5/5", "4.5 out of 5", "★★★★★", "(5/5)", "Verified buyer". */
const RATING =
  /(?:^|[\s(])\d(?:\.\d)?\s*(?:\/|out of)\s*5(?:\s*stars?)?(?:\)|$)|[★☆]{2,}|^\d(?:\.\d)?\s*stars?$|\bverified (?:buyer|purchase|owner|reviewer)\b/i;

/**
 * A link or button that sells: the block holding one is an offer. "Learn
 * more" and "Read more" are not here — a genuine feature card often links to
 * a longer explanation of itself.
 */
const SELLING_ACTION =
  /^(?:add to (?:cart|bag|basket)|buy(?: it)? now|shop now|shop all|order now|pre-?order now|choose options|select options|quick (?:shop|add))[.!]?$/i;

/**
 * A block at most this long that holds a selling link is a banner or a tile
 * for some product — often a different one — so the headings and cards read
 * inside it are dropped. A longer block is a page section, and a buy button
 * somewhere in it says nothing about the rest of what it contains.
 */
const OFFER_BLOCK_TEXT = 1_000;
/** …and at most this many elements directly inside it: a tile, not a page region. */
const OFFER_BLOCK_CHILDREN = 4;

/** Narrative sections kept per document, and the text kept of each. */
const MAX_NARRATIVES = 40;
const MAX_NARRATIVE_TEXT = 20_000;

/**
 * Whether a heading's content is prose rather than a value (D-123): longer
 * than any value is kept, or a paragraph of two or more sentences. Shape only,
 * never the heading's wording.
 */
function isNarrative(lines: string[]): boolean {
  const text = lines.join(" ");
  const sentences = (text.match(/[.!?](?=\s|$)/g) ?? []).length;
  return text.length > MAX_VALUE || (text.length >= 160 && sentences >= 2);
}

/** A layout row or card whose title runs past this many words is prose, not a label. */
const MAX_LABEL_WORDS = 8;

/** Text that is a JSON literal, which is data a script reads, not something a person reads. */
const JSON_TEXT = /^\s*[[{]\s*"[^"\n]{1,80}"\s*:/;

function isNoiseText(text: string): boolean {
  const value = cleanText(text);
  return CALL_TO_ACTION.test(value) || RATING.test(value);
}

type Frame = {
  tag: string;
  text: string;
  /** Characters of this element's text that were inside a link. */
  linkChars: number;
  /** False while the element has only inline children: a cell, not a container. */
  hasBlockChild: boolean;
  elementChildren: number;
  /** The first two element children, which is all a two-cell row needs. */
  cellsSeen: { tag: string; text: string; leaf: boolean; linkChars: number }[];
  /**
   * The children that carry any text, up to three. A feature card is an
   * image, a title and a paragraph; only the last two say anything.
   */
  textChildren: { tag: string; text: string; leaf: boolean; linkChars: number }[];
  textChildCount: number;
  /** This element or one it is inside is page furniture. */
  furniture: boolean;
  /** A button, a form control or a selling link is somewhere inside. */
  interactive: boolean;
  /** A selling link or button is somewhere inside. */
  selling: boolean;
  /** How many pairs existed when this element opened; later ones were read inside it. */
  pairStart: number;
  /**
   * Undecided until the element's own text starts; true when it starts as a
   * JSON literal — the store an `x-data` container or a hidden configuration
   * block leaves in the markup — and then none of that text is read.
   */
  jsonText: boolean | null;
  /** The heading this element has passed, and the blocks since. */
  label: string | null;
  labelLinkChars: number;
  /** A block under the heading was interactive: the heading is selling something. */
  labelInteractive: boolean;
  parts: string[];
  /**
   * True once this element's own heading produced pairs. Its text is then not
   * folded into an outer heading's value as well, which is what would
   * otherwise report every specification twice — once for the section that
   * states it and once for the section that contains that section.
   */
  consumed: boolean;
};

function newFrame(tag: string, furniture: boolean, pairStart: number): Frame {
  return {
    tag,
    selling: false,
    pairStart,
    text: "",
    linkChars: 0,
    hasBlockChild: false,
    elementChildren: 0,
    cellsSeen: [],
    textChildren: [],
    textChildCount: 0,
    furniture,
    interactive: false,
    jsonText: null,
    label: null,
    labelLinkChars: 0,
    labelInteractive: false,
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

/**
 * A label → value pair noticed in markup or text, and any identity it names.
 * Returns whether it was kept.
 */
function addPair(pairs: ExtractedPair[], identity: Required<ExtractedIdentity>, pair: Omit<ExtractedPair, "unit">): boolean {
  const label = cleanText(pair.label).replace(/[:\s]+$/, "").replace(TRAILING_FOOTNOTE, "");
  const value = cleanText(pair.value);
  if (FOOTNOTE_MARK.test(value)) return false;
  if (!label || !value || label.length > MAX_LABEL || pairs.length >= MAX_PAIRS) return false;
  // "Model O…: Add to Cart", "Nathan k.: 5/5" — an action or a review score.
  if (isNoiseText(label) || isNoiseText(value)) return false;
  const kind = identityLabelKind(label);
  const field = kind ? IDENTITY_FIELD[kind] : undefined;
  if (field) identity[field].push(clip(value, 120));
  pairs.push({ ...pair, label, value: clip(value, MAX_VALUE), unit: null });
  return true;
}

/**
 * The same statement read twice — once as a heading and the block after it,
 * once as the two-element row the same markup also is — is one pair. The
 * first reading is kept. Values are compared without the separators the two
 * readers join lines with.
 */
function dedupePairs(pairs: ExtractedPair[]): ExtractedPair[] {
  const seen = new Set<string>();
  return pairs.filter((pair) => {
    const key = `${labelKey(pair.label)}|${pair.value.toLowerCase().replace(/[\s;,.]+/g, " ").trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type ExtractOptions = {
  /** The address the document was read from; it tells which version a family page is showing. */
  url?: string;
};

export function extractHtml(html: string, options: ExtractOptions = {}): Extraction {
  const pairs: ExtractedPair[] = [];
  const narratives: ExtractedNarrative[] = [];
  const identity = emptyIdentity();
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
    const selling = frame.labelInteractive;
    frame.label = null;
    frame.parts = [];
    frame.labelLinkChars = 0;
    frame.labelInteractive = false;
    if (heading === null || frame.furniture) return;
    // A heading over an "Add to Cart" or a "Shop now" is an offer, not a fact.
    if (selling) return;

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
      // "Step 2: Apply…" is a line of the heading's procedure, not an
      // attribute called "Step 2" (D-123).
      if (labelled && /\p{L}/u.test(labelled[1]) && !SEQUENCE_LABEL.test(cleanText(labelled[1]))) {
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
    /*
     * A page section, not an attribute (D-123). "DETAILS", "DESCRIPTION",
     * "HOW TO USE IT" over paragraphs of sentences is where the facts are, not
     * what they are called; turned into a pair it became a label a person was
     * asked to make an attribute of, and a value cut at 400 characters. It is
     * kept whole instead, beside the pairs, for a reader that can find the
     * statements inside it. Judged by shape only: a short value — "SBC; AAC;
     * LDAC", "48 Ω (1 kHz)", even a two-sentence note — is still a value.
     */
    if (isNarrative(folded)) {
      frame.consumed = true;
      if (narratives.length < MAX_NARRATIVES) {
        narratives.push({ heading: label, text: folded.join("\n").slice(0, MAX_NARRATIVE_TEXT), locator: `section "${label.slice(0, 40)}"` });
      }
      return;
    }
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
    if (frame.furniture || frame.interactive) return;
    if (frame.elementChildren !== 2 || frame.cellsSeen.length !== 2) return;
    if (frame.tag === "tr" || frame.tag === "dl" || HEADING_TAGS.has(frame.tag)) return;
    const [first, second] = frame.cellsSeen;
    if (!first.leaf || !second.leaf) return;
    const label = cleanText(first.text).replace(/[:\s]+$/, "");
    const value = cleanText(second.text);
    if (!label || !value || label === value) return;
    if (label.length > MAX_LABEL || !/\p{L}/u.test(label)) return;
    // A sentence broken across two elements is not a label and its value.
    if (label.split(" ").length > MAX_LABEL_WORDS) return;
    if ((first.linkChars + second.linkChars) / (label.length + value.length) > LINK_TEXT_SHARE) return;
    // A title over a paragraph of prose is a section, kept whole (D-123).
    if (isNarrative([value])) {
      if (narratives.length < MAX_NARRATIVES && !narratives.some((entry) => entry.heading === label)) {
        narratives.push({ heading: label, text: value.slice(0, MAX_NARRATIVE_TEXT), locator: `section "${label.slice(0, 40)}"` });
      }
      return;
    }
    addPair(pairs, identity, {
      label,
      value,
      method: "html_table",
      locator: `${frame.tag} row "${label.slice(0, 40)}"`,
      excerpt: clip(`${label}: ${value}`, 1000),
    });
  };

  /*
   * Emits the pair a feature card produced: a short title and the paragraph
   * that explains it, usually beside an icon — `<div><div><img></div>
   * <div>Ultralight Weight</div><p>At just 69g…</p></div>`. Only the elements
   * that carry text count, so the icon does not stop the card being read.
   *
   * Conservative on purpose: exactly two text-carrying children, both plain
   * (no blocks inside), the second a paragraph that says more than the title,
   * the title not itself a sentence, nothing to click, not furniture and not
   * mostly link text. A product tile in a cross-sell carries a price and a
   * button; a review carries a name, a score and usually a date — none of them
   * is this shape.
   */
  const flushCard = (frame: Frame) => {
    if (frame.furniture || frame.interactive) return;
    // Two elements and nothing else is a layout row, which `flushRow` reads.
    if (frame.textChildCount !== 2 || frame.elementChildren < 3) return;
    const [title, body] = frame.textChildren;
    if (!title.leaf || !body.leaf || body.tag !== "p" || title.tag === "p") return;
    // A heading and its paragraph are the heading reader's.
    if (HEADING_TAGS.has(title.tag)) return;
    const label = cleanText(title.text).replace(/[:\s]+$/, "");
    const value = cleanText(body.text);
    if (!label || !value || label.length > MAX_LABEL || !/\p{L}/u.test(label)) return;
    if (label.split(" ").length > MAX_LABEL_WORDS) return;
    if (/[.!?]$/.test(label) || value.length <= label.length) return;
    if ((title.linkChars + body.linkChars) / (label.length + value.length) > LINK_TEXT_SHARE) return;
    // A card whose paragraph is prose is a small section, kept whole (D-123).
    if (isNarrative([value])) {
      if (narratives.length < MAX_NARRATIVES) {
        narratives.push({ heading: label, text: value.slice(0, MAX_NARRATIVE_TEXT), locator: `card "${label.slice(0, 40)}"` });
      }
      return;
    }
    addPair(pairs, identity, {
      label,
      value,
      method: "html_text",
      locator: `card "${label.slice(0, 40)}"`,
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
        const frame = newFrame(name, (parent?.furniture ?? false) || isFurniture(name, attributes), pairs.length);
        if (INTERACTIVE_TAGS.has(name)) frame.interactive = true;
        frames.push(frame);
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
        const frame = frames[frames.length - 1];
        if (frame && frame.jsonText === null && chunk.trim()) frame.jsonText = JSON_TEXT.test(chunk);
        if (frame?.jsonText) return;
        if (cellBuffer !== null) cellBuffer += chunk;
        if (dtBuffer !== null) dtBuffer += chunk;
        if (ddBuffer !== null) ddBuffer += chunk;
        if (frame) appendFrameText(frame, chunk);
        // Menus, footers and reviews are not what the page says about the product.
        if (frame?.furniture) return;
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
          if (cells.length === 2 && !frame?.furniture) {
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
          if (pendingTerm !== null && !frame?.furniture) {
            addPair(pairs, identity, {
              label: pendingTerm,
              value: ddBuffer,
              method: "html_table",
              locator: `dl[${dlIndex}] ${cleanText(pendingTerm).slice(0, 40)}`,
              excerpt: clip(`${cleanText(pendingTerm)}: ${cleanText(ddBuffer)}`, 1000),
            });
          }
          pendingTerm = null;
          ddBuffer = null;
        }

        if (!frame) return;
        // A link or button that reads "Shop now" makes the block around it an offer.
        if ((frame.tag === "a" || frame.tag === "button") && SELLING_ACTION.test(cleanText(frame.text))) {
          frame.selling = true;
          frame.interactive = true;
        }
        // The option a variant picker shows as selected (D-123).
        if (frame.tag === "label" && !frame.furniture && !frame.hasBlockChild) {
          const selected = SELECTED_OPTION.exec(cleanText(frame.text));
          if (selected && selected[1].trim().split(" ").length <= 3 && !isNoiseText(selected[2])) {
            const before = pairs.length;
            addPair(pairs, identity, {
              label: selected[1],
              value: selected[2],
              method: "html_text",
              locator: `selected option "${cleanText(selected[1]).slice(0, 40)}"`,
              excerpt: clip(cleanText(frame.text), 1000),
            });
            if (pairs.length > before) pairs[pairs.length - 1].scope = "variant";
          }
        }
        if ((frame.tag === "title" || frame.tag === "h1") && !frame.furniture && documentNames < 4) {
          const name = cleanText(frame.text);
          if (name) {
            identity.names.push(clip(name, 200));
            documentNames += 1;
          }
        }
        // A heading still open inside this element belongs to this element.
        flushHeading(frame);
        flushRow(frame);
        flushCard(frame);
        // A banner or tile selling something: what its headings and cards said
        // is about that offer. Table and list rows are never removed here.
        const offerBlock =
          frame.selling &&
          frame.elementChildren <= OFFER_BLOCK_CHILDREN &&
          cleanText(frame.text).length <= OFFER_BLOCK_TEXT;
        if (offerBlock && pairs.length > frame.pairStart) {
          const kept = pairs.slice(frame.pairStart).filter((pair) => pair.method !== "html_text");
          pairs.splice(frame.pairStart, pairs.length - frame.pairStart, ...kept);
        }

        // A table, a list or a card that produced pairs of its own is not also
        // folded into the heading above it — "Tech Specs: Warranty2 years; …".
        if (pairs.length > frame.pairStart) frame.consumed = true;

        const parent = frames[frames.length - 1];
        if (!parent) return;
        // Past a small block, a buy button says nothing about its surroundings.
        if (offerBlock) parent.selling = true;
        const linkChars = frame.linkChars + (frame.tag === "a" ? frame.text.length : 0);
        const leaf = !frame.hasBlockChild;
        parent.elementChildren += 1;
        if (parent.cellsSeen.length < 2) {
          parent.cellsSeen.push({ tag: frame.tag, text: frame.text, leaf, linkChars });
        }
        if (frame.text.trim()) {
          parent.textChildCount += 1;
          if (parent.textChildren.length < 3) parent.textChildren.push({ tag: frame.tag, text: frame.text, leaf, linkChars });
        }
        parent.linkChars += linkChars;
        if (frame.interactive) parent.interactive = true;
        if (BLOCK_TAGS.has(frame.tag)) parent.hasBlockChild = true;
        appendFrameText(parent, frame.text);

        if (HEADING_TAGS.has(frame.tag)) {
          flushHeading(parent);
          parent.label = frame.text;
        } else if (parent.label !== null && frame.interactive) {
          parent.labelInteractive = true;
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

  readJsonLd(jsonLd, pairs, identity, structured, options);
  return { pairs: dedupePairs(pairs), identity: dedupeIdentity(identity), structuredData: structured, text: collapse(text.join(" ")), narratives };
}
export function extractText(content: string): Extraction {
  const pairs: ExtractedPair[] = [];
  const identity = emptyIdentity();
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

export function extractJson(content: string, options: ExtractOptions = {}): Extraction {
  const pairs: ExtractedPair[] = [];
  const identity = emptyIdentity();
  const structured: unknown[] = [];
  readJsonLd([content], pairs, identity, structured, options);
  return { pairs: dedupePairs(pairs), identity: dedupeIdentity(identity), structuredData: structured, text: collapse(content.slice(0, MAX_TEXT)) };
}

export function extractDocument(content: string, contentType: string, options: ExtractOptions = {}): Extraction {
  if (contentType === "text/html" || contentType === "application/xhtml+xml") return extractHtml(content, options);
  if (contentType === "application/json" || contentType === "application/ld+json") return extractJson(content, options);
  return extractText(content);
}

/** Visible text as stored: invisible storage noise removed, whitespace collapsed. */
function collapse(text: string): string {
  return removeStorageNoise(text).replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function dedupeIdentity(identity: Required<ExtractedIdentity>): ExtractedIdentity {
  const unique = (values: string[]) => [...new Set(values.map((value) => cleanText(value)).filter(Boolean))].slice(0, 20);
  return {
    names: unique(identity.names),
    brands: unique(identity.brands),
    gtins: unique(identity.gtins),
    mpns: unique(identity.mpns),
    models: unique(identity.models),
    skus: unique(identity.skus),
    offers: identity.offers,
    variants: identity.variants,
    displayedVariant: identity.displayedVariant,
  };
}
