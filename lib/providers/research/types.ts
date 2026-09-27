/**
 * Finding candidate sources for a product, from whatever mechanism the shop
 * has (A-6). Discovery is provider-agnostic on purpose: the Brand Source
 * Registry, staff-supplied URLs, staff-supplied documents and approved feeds
 * all work with nothing configured, and a paid search service is one more
 * implementation of this interface rather than a requirement.
 *
 * A provider that cannot answer says so. It never guesses a URL, and it never
 * returns content it did not retrieve — inventing a plausible source would be
 * worse than reporting that discovery is unavailable.
 */

export type ResearchQuery = {
  /** The product as the knowledge base knows it. */
  name: string;
  brand: string | null;
  modelNumbers: string[];
  gtins: string[];
  /** Domains the Brand Source Registry already approves for this brand. */
  preferredDomains: string[];
  limit: number;
  /**
   * What sets this version apart — a shade, colour or size the knowledge base
   * records (D-123). Added to a name-only query when the name does not
   * already say it.
   */
  variantValues?: string[];
};

export type ResearchCandidate = {
  url: string;
  title: string | null;
  /** Why the provider believes this page is about the product, in its words. */
  note: string | null;
};

export type ResearchResult =
  /**
   * `notes`: what the provider could not do on the way, in words a person
   * can act on ("local web search is not running"), recorded with the run.
   */
  | { status: "OK"; candidates: ResearchCandidate[]; notes?: string[] }
  /** No provider is set up. Expected, and not an error. */
  | { status: "NOT_CONFIGURED"; message: string }
  /** Configured but unusable right now: quota, outage, missing credential. */
  | { status: "UNAVAILABLE"; message: string }
  | { status: "FAILED"; message: string };

export type ProductResearchProvider = {
  readonly key: string;
  findSources(query: ResearchQuery): Promise<ResearchResult>;
};
