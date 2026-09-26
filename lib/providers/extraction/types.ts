/**
 * Reading a retrieved document for facts its tables do not hold (D-123).
 *
 * The deterministic readers in `lib/pkb/extract.ts` read what a page states
 * as structure: JSON-LD, tables, definition lists, headings over values. A
 * great many consumer pages state their facts in sentences instead — "delivers
 * 100% gray coverage", "leave it on for 25 minutes" — and those readers can
 * only hand such a paragraph over whole, as a label nobody can use.
 *
 * A provider here is asked one narrow question about one document Manifest
 * already retrieved: *what does this text say about the product, and where
 * exactly does it say it?* It is given the text and nothing else, it does not
 * browse, and what it returns is not believed. Every candidate is checked
 * against the document's own text (`lib/pkb/grounding.ts`) before it may even
 * become a proposal; the evidence stored is the page's excerpt, never the
 * provider's wording; and a claim it leads to is accepted by a person under a
 * verification policy like any other.
 *
 * This is deliberately a different boundary from SEO Pulse's content
 * generator, though both may use the same vendor: that one writes wording
 * from facts already established, this one points at facts in a source.
 * Their trust rules are opposite, so they share no code.
 */

/** What kind of statement a candidate is, as the provider read it. */
export const CANDIDATE_KINDS = [
  "identity",
  "product_fact",
  "variant_fact",
  "box_content",
  "composition",
  "compatibility_use",
  "warning_safety",
  "marketing",
] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export type ExtractionCandidate = {
  /** The label the page uses, or the concept the value is, in a few words. */
  label: string;
  /** The value, as the page states it. */
  value: string;
  unit: string | null;
  /** The page's own words that state it, copied exactly. */
  excerpt: string;
  /** The heading or section the excerpt sits under, when there is one. */
  section: string | null;
  /** What attribute the provider thinks this is ("hair colour shade", "net weight"). A suggestion only. */
  meaning: string | null;
  kind: CandidateKind;
};

export type DocumentExtractionRequest = {
  product: {
    name: string;
    brand: string | null;
    /** The family or category the product is filed under, for context. */
    family: string | null;
    /** The one version of a multi-version page this product is, when known. */
    variant: string | null;
  };
  document: {
    url: string | null;
    title: string | null;
    /** The document's visible text, as Manifest stored it. */
    text: string;
  };
  /** Attribute labels the family already has, so a candidate can use the same words. */
  knownLabels: string[];
  maxCandidates: number;
};

export type DocumentExtractionResult =
  | {
      status: "OK";
      candidates: ExtractionCandidate[];
      model: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
    }
  /** No provider is set up. Expected, and not an error. */
  | { status: "NOT_CONFIGURED"; message: string }
  /** Configured but unusable right now: missing key, quota, outage. */
  | { status: "UNAVAILABLE"; message: string }
  | { status: "FAILED"; message: string };

export type ProductDocumentExtractionProvider = {
  readonly key: string;
  extract(request: DocumentExtractionRequest): Promise<DocumentExtractionResult>;
};
