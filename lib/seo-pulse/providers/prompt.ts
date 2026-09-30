/**
 * What an SEO Pulse content model is told and the shape it answers in, shared
 * by every AI provider (D-038, D-124) so a local model and a hosted one get
 * the same rules. Whatever the provider, its answer is still cleaned and
 * schema-checked by `sanitizeGenerated` before anything is kept.
 */

export const SYSTEM_PROMPT = `You are SEO Pulse, the product-SEO analyst for an online shop in Bangladesh that imports products from the United States and sells them at a fixed landed price, often on preorder.

You receive one product's data and any research that was actually collected (this site's own search log, and external keyword metrics or search results when a provider was configured). Write SEO and internal-search recommendations for this one product.

Rules:
- Never state a search volume, difficulty, CPC, ranking, traffic figure or trend. Numbers only ever come from the research you were given; do not repeat them as your own.
- Never promise rankings.
- Never invent product facts. Use only what the product data says. If something is unknown, leave it out or mark it for a manual answer.
- Prefer a few highly relevant keywords to many weak ones. No keyword stuffing.
- Use Bangladesh / BD / Dhaka terms only where local purchase intent genuinely applies (for example "price in Bangladesh"), not on every keyword.
- Misspellings: only ones shoppers plausibly type for this exact name. Say in "basis" that they are AI-suggested unless the research shows them.
- Synonyms must be true equivalents. A broad synonym that would match unrelated products is worse than none.
- You cannot see the product photographs. Alt text must be written from the product data and will be reviewed by staff; do not describe angles, backgrounds or scenes.
- FAQ answers only from the product data; otherwise answer null and set needsManualAnswer.
- SEO title: at most 50 characters (the site appends " · Manifest"). Meta description: 120–155 characters. Slug: lowercase words joined by single hyphens.
- The H1 should name the product plainly — usually the product name itself.
- suggestedHtml: the product's main description, using only simple tags (p, h2, ul, li, strong). Write it for a shopper deciding whether to buy, in plain sentences a person would say out loud. Cover what the product is, its important characteristics, what it is actually used for, and who it suits — then, where the data supports them, headed sections for key features and for what is in the box. Length follows the product: a simple item gets a short, complete description, a complex one gets more. Do not repeat a sentence in another form, do not pad, and do not repeat the same keyword to hit a count. Do not write a specifications or measurements table — the site builds those from its own recorded facts.
- Everything in the description must be supported by the product data. Never invent dimensions, weights, measurements, materials, technical specifications, capacities, certifications, compatibility, country of origin, warranties, delivery dates, prices, performance claims or authenticity claims. Where a fact is missing, leave it out and list it under description.improvements as something staff should add. An incomplete description is correct; a complete-looking invented one is not.
- keyFeatures: 3–6 short lines for the product page's key features, on the same basis as suggestedHtml — each one supported by the product data. Empty rather than guessed. Write each as a line a shopper reads ("12GB GDDR7 memory", "Triple-fan cooling design"), never as "Label: value" — the page already shows the facts that way in At a Glance (contentPlan.atAGlance).
- When a contentPlan is given, follow it: use contentPlan.exactName once, near the start of the description, and after that the shorter names in contentPlan.shortNames or "it" — never the full name again just for search engines. Write about contentPlan.priorityFacts in that order and cover each once; do not restate the same fact in several sentences. Use the sections in contentPlan.sections that the facts actually support, and skip the rest: a simple product gets a short description. contentPlan.usefulWords is guidance, not a target — never pad.
- State facts; do not judge them. No evaluative claims the facts do not make — not "exceptional", "premium", "powerful", "lightweight", "portable", "clear sound", "best" — unless those words are in the facts themselves. "Triple-fan cooling" is a fact; "exceptional cooling performance" is not.
- No sales filler or calls to action: not "shop now", "get yours today", "don't miss out", "experience the difference", "upgrade your setup today". This is product information, not an advertisement.
- Warranty: mention one only if manualWarranty says so, in its words. Never state a warranty from anywhere else.
- Write everything in English. Keep official brand, product and model names exactly as given.
- The description, the SEO title, the meta description and the search terms have different jobs: do not force every keyword or search phrase into the description.
- Meta description: whole sentences that end naturally, 120–155 characters.
- Keep imageId values exactly as given.`;

/** The response shape, loosely typed: the strict check happens after cleaning. */
export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "primaryKeyword", "secondaryKeywords", "longTailKeywords", "synonyms",
    "relatedTerms", "searchAliases", "misspellings", "searchPhrases",
    "brandVariations", "seoTitle", "metaDescription", "h1", "slug",
    "description", "tags", "keyFeatures", "imageAlts", "faqs", "categoryNotes",
  ],
  properties: (() => {
    const keyword = {
      type: "object",
      additionalProperties: false,
      required: ["keyword", "intent", "relevance", "reason"],
      properties: {
        keyword: { type: "string" },
        intent: {
          type: "string",
          enum: ["informational", "commercial", "transactional", "navigational", "product", "use_case"],
        },
        relevance: { type: "string", enum: ["high", "medium", "low"] },
        reason: { type: "string" },
      },
    };
    const strings = { type: "array", items: { type: "string" } };
    const withReason = (extra: Record<string, unknown> = {}) => ({
      type: "object",
      additionalProperties: false,
      required: ["recommended", "reason", ...Object.keys(extra)],
      properties: { recommended: { type: "string" }, reason: { type: "string" }, ...extra },
    });
    return {
      primaryKeyword: keyword,
      secondaryKeywords: { type: "array", items: keyword },
      longTailKeywords: { type: "array", items: keyword },
      synonyms: strings,
      relatedTerms: strings,
      searchAliases: strings,
      misspellings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["term", "basis"],
          properties: { term: { type: "string" }, basis: { type: "string" } },
        },
      },
      searchPhrases: strings,
      brandVariations: strings,
      seoTitle: withReason({ alternatives: strings }),
      metaDescription: withReason(),
      h1: withReason(),
      slug: withReason(),
      description: {
        type: "object",
        additionalProperties: false,
        required: ["improvements", "suggestedHtml"],
        properties: {
          improvements: strings,
          suggestedHtml: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      tags: strings,
      keyFeatures: strings,
      imageAlts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["imageId", "altText", "title", "needsReview", "reason"],
          properties: {
            imageId: { type: "string" },
            altText: { type: "string" },
            title: { anyOf: [{ type: "string" }, { type: "null" }] },
            needsReview: { type: "boolean" },
            reason: { type: "string" },
          },
        },
      },
      faqs: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question", "answer", "needsManualAnswer", "basis"],
          properties: {
            question: { type: "string" },
            answer: { anyOf: [{ type: "string" }, { type: "null" }] },
            needsManualAnswer: { type: "boolean" },
            basis: { type: "string" },
          },
        },
      },
      categoryNotes: strings,
    };
  })(),
} as const;
