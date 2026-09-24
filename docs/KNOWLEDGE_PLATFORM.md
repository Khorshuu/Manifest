# Knowledge Platform — Implementation Tracker

The continuity record for the eight-stage programme that puts Manifest on one
Product Knowledge Base (PKB) shared by the storefront, **SeoPulse** and
**SearchPulse**. Read this file first at the start of every stage. It holds the
status, the architecture, the invariants and what comes next; the reasoning
behind each decision is in [DECISIONS.md](DECISIONS.md) (D-060 to D-070).

- Branch: `production-readiness`
- Started: 2026-09-17, on commit `1e2e9d3`
- Rules for this programme: one stage at a time, and each stage ends with a
  hard stop until the owner replies `CONTINUE STAGE N`. Nothing is deployed,
  pushed, published or bought. Intermediate stages run targeted checks; the
  full suite belongs to Stage 8.

---

## 1. Objective

Turn every product Manifest processes into a structured, source-backed,
reusable product identity — brand, model, identifiers, family, normalized
attributes, variants, relationships, aliases and the evidence behind each fact
— and make the storefront, SEO and internal search all read that one
foundation instead of keeping their own copies of product truth.

Guiding rules, in the order they win: reliability over clever AI; evidence over
guessing; unknown over fabricated; one source of truth; provenance on every
fact; admin approval before mutation; deterministic logic before AI.

---

## 2. Stage status

| Stage | Scope | Effort | Status |
| --- | --- | --- | --- |
| 1 | Repository audit, architecture, source-of-truth decisions | ULTRACODE | **COMPLETE** (2026-09-17) |
| 2 | PKB database foundation: identity, families, attributes, normalization, variants, provenance, migrations, backfill | MAX | **COMPLETE** (2026-09-17) — see section 3A |
| 3 | SeoPulse product intelligence: resolution, brand source registry, sources, claims, conflicts, review and apply | EXTRA HIGH | **COMPLETE** (2026-09-18) — see section 3B |
| 4 | SEO engine: metadata states, structured data, technical SEO, image SEO, internal links, duplicate and thin content, SEO Health Center | HIGH | **COMPLETE** (2026-09-18) — see sections 3C and 3C.1b |
| 5 | SearchPulse: query understanding, aliases, attribute-aware search, typo tolerance, autocomplete, facets, analytics | EXTRA HIGH | **COMPLETE** (2026-09-18) — see section 3D |
| 6 | Google Search Console, opportunity detection, SEO change history, controlled learning | HIGH | **COMPLETE** (2026-09-18) — see section 3E |
| 7 | Hardening: security, SSRF, write safety, performance, legacy contract, observability, provider abstraction | MAX | **COMPLETE** (2026-09-24) — see section 3F. The legacy contraction was deliberately not done; the coverage report says why (D-103, D-105) |
| 8 | Final production audit and full verification | ULTRACODE | **COMPLETE** (2026-09-24) — see section 3G |
| 9 | Product preparation: identity on the product save, automatic resolution, the durable orchestration behind "Research & Prepare with SeoPulse", the research provider boundary, and the PKB → SeoPulse grounded context | MAX | **BACKEND COMPLETE** (2026-09-24) — see section 3H. The product-entry interface is deliberately a separate piece of work |
| 10 | The staff product-entry screen: Add Product, "Research & Prepare with SeoPulse", the one progress surface, review-only-exceptions, and the reordered product editor | HIGH | **COMPLETE** (2026-09-24) — see section 3I. No backend change |

---

## 3. Stage 1 — what was done

Audited the real repository (Drizzle schema, the search, SeoPulse and option
migrations 0012/0014/0019/0020, the migration ledger, `lib/catalog`,
`lib/search`, `lib/seo-pulse`, `lib/seo.ts`, product and category pages,
sitemap, robots, the admin product editor, jobs, cache, RBAC, media, tests and
the living docs) and profiled the development database. No application code
was changed in this stage; the output is this tracker, decisions D-060 to
D-069, and pointers in ARCHITECTURE.md, DATABASE.md and PROGRESS.md.

### 3.1 What exists today

**Product model — one row does four jobs.** `products` is at once the shop
listing, the product's identity, its factual record and its SEO record. Facts
about one product are spread over seven stores, none of them with a source,
a date or a verification state:

| Store | Shape | Written by |
| --- | --- | --- |
| `products.brand` | free text | Basics panel |
| `products.identifier_type` + `identifier_value` | one identifier of seven types | Basics panel |
| `products.details` | JSON, 18 fixed keys typed in `ProductDetails` (manufacturer, MPN, model number, material, colour, weight, dimensions…), all free text | Specifications panel |
| `products.attribute_values` | JSON keyed by `category_attributes.id`, raw strings (D-025) | Specifications panel |
| `products.spec_table` | JSON label/value rows, free text | Specifications panel, SeoPulse fill |
| `products.measurements` | JSON label/value rows, free text (D-043) | Specifications panel, SeoPulse fill |
| `products.compliance.countryOfOrigin`, `products.warranty` | JSON | Warranty & safety panel |

The product page assembles its Specification tab from brand + category
specifications + `details` + `spec_table` + country of origin + identifier,
and its Measurements tab from `measurements` + the measurable `details` keys
(`app/(storefront)/products/[slug]/page.tsx`).

**Classification.** `categories` is a three-level navigation tree.
`category_attributes` (D-025) defines per-category specifications inherited
down the tree: name, one of nine data types, a free-text unit, choices,
required/filterable/searchable flags. There is no product family, no product
type, no stable attribute key, no schema version, no unit dimension, and no
variant-defining, SEO or structured-data flag.

**Brands.** Free text on the product. No brand entity, no aliases. The
storefront brand facet groups by the exact string.

**Variants.** `product_variants` mixes the commercial offer (price, sale
window, stock, preorder capacity, payment mode, merchant SKU) with a few
physical facts (`weight_grams`, used by landed-price bookkeeping;
`dimensions_mm`). Options are product-owned since D-040: `attributes`
(free-text name per product) → `attribute_values` → `variant_option_values`.
Filters join option names across products by slug of the name, so "Color" and
"Colour" are two filters.

**Relationships.** `product_related` holds merchandising links only
(`related`, `frequently_bought_together`, `also_viewed`). There is no
accessory, compatibility, predecessor or successor relationship, and no way to
refer to a product Manifest does not sell.

**SeoPulse today** (`lib/seo-pulse`, D-038, D-040, D-043). An admin presses a
button; the request loads the product, reads this site's search log, calls the
optional DataForSEO provider, then the rules generator or Claude, and stores
one versioned `seo_research_runs` row with `research` and `analysis` JSON.
"Fill with SeoPulse" writes into empty fields (focus keyword, SEO title, meta
description, description, key features, specification and measurement tables,
tags, search keywords). "Apply" writes chosen fields with an explicit Replace
for non-empty ones. Strengths worth keeping: provider interfaces with safe
defaults, research kept apart from analysis, request-key idempotency, reuse of
unchanged research, per-staff hourly cap, strict schema and sanitising of AI
output, facts (gaps, identifiers, schema readiness) computed by code rather
than AI, CSV formula-injection guard, `catalog.manage` checked inside `lib/`.

**SearchPulse today.** There is no module by that name; the internal search is
`lib/search` plus `lib/catalog/{discovery,facets,filter-params}` (D-026 to
D-030). A trigger-maintained `product_search` row per product holds a weighted
tsvector (A name; B brand, model, codes, keywords, shelf; C highlights,
options, specifications; D description and the rest), normalized name, brand,
shelf and codes. `product_search_words` feeds trigram typo correction.
Ranking is a relevance tier first (exact code → exact name → brand → phrase in
name → words in name → strong fields → specs → anywhere). Synonyms are
staff-written. Search logs use a daily-rotating visitor hash, never an account
id, and drop email- or phone-shaped queries. Facets merge variant options and
filterable category specifications per request from JSON.

**SEO today.** `generateMetadata` on product, category and search pages;
product canonical is `canonical_url` or the product path; filtered/sorted
category pages and search pages are `noindex, follow`. `lib/seo.ts` builds
`Product` (name, url, description from the meta description, brand, first
image, one `Offer` at the cheapest variant, rating only with approved reviews),
`BreadcrumbList` and `OnlineStore`. Sitemap lists public products and every
category. Robots disallows private areas. No redirect table, no category SEO
fields, no per-field SEO state, no field-level SEO history, no Search Console.

**Infrastructure to reuse.** SQL migrations with a checksum ledger
(`db/migrator.ts`); Drizzle declarations in `db/schema/`; PGlite and
real-Postgres test helpers; the durable job runner (`lib/jobs`, D-053); cache
tags invalidated from audit entries (`lib/cache.ts`, D-054); permissions table
(`lib/auth/authorize.ts`, D-034); `audit_log`; structured logging with
redaction and Sentry (`lib/observability`); media registry with image
dimensions (`media_objects`).

**Development data** (database `preorder`): 24 products, 26 variants,
12 categories (three levels), 2 category specifications, 4 option groups,
6 synonyms, 0 SeoPulse runs, 0 logged searches, 0 orders. Every product has a
non-empty `spec_table`; one has `details`; one has an identifier (UPC); none
has measurements. Real production volumes are unknown, so the backfill must be
written for arbitrary data, not for this sample.

### 3.2 Classification of existing systems

| System | Verdict | Why / what changes |
| --- | --- | --- |
| `products` as the listing (title, slug, status, publish dates, description, bullets, tags, images, video, searchable, boost) | REUSE | Stays the commercial listing Manifest sells. Gains `pkb_product_id`. |
| `products.brand`, `identifier_*`, `details`, `attribute_values`, `spec_table`, `measurements`, `compliance.countryOfOrigin` | MIGRATE | Backfilled into the PKB as LEGACY facts; then written only as projections; contracted in Stage 7 once no reader remains. |
| `products.seo_*`, `slug`, `canonical_url` | EXTEND | Stay the listing's SEO fields; gain per-field AUTO/SUGGESTED/MANUAL/LOCKED state and history (Stage 4, 6). |
| `products.search_keywords` | MIGRATE (partial) | Kept as listing-level legacy keywords; entity aliases move to approved `pkb_aliases` (Stage 5). |
| `categories` | REUSE | Navigation and merchandising only. Gains optional `default_family_id`. |
| `category_attributes` | MIGRATE → REMOVE/OBSOLETE | Definitions become global attribute definitions attached to families; retired after readers move (Stage 7). |
| `product_variants` | REUSE as the Offer | Price, sale, stock, capacity, payment, merchant SKU, shipping weight. Gains `pkb_variant_id`. |
| `attributes` / `attribute_values` / `product_attributes` / `variant_option_values` | EXTEND | Remain the listing's selection axes and combination engine (D-006, D-040). `attributes` gains `attribute_definition_id`; option values map to normalized variant facts. |
| `product_related` | REUSE | Merchandising links, not facts. Factual relationships are new PKB rows. |
| `lib/catalog/category-attributes.ts` (validation on save) | REFACTOR | Validation moves to family schemas in `lib/pkb`. |
| `lib/seo-pulse` providers, run versioning, request keys, sanitising, export, caps | REUSE | Foundation for the intelligence pipeline. |
| `lib/seo-pulse/service.ts` `fillWithSeoPulse` | REFACTOR | Must produce proposals, not writes; must stop copying facts into `spec_table`/`measurements` (finding F1, F2). |
| `lib/seo-pulse/service.ts` `applySeoPulse` | REFACTOR | One transaction; field states; history (F3). |
| `lib/seo-pulse` synchronous research in the request | REFACTOR | Runs as a job (F4). |
| `lib/seo-pulse/scores.ts` 0–100 scores | REFACTOR | Replaced by measurable pass/fail checks and counts (Stage 4, F13). |
| `seo_research_runs` | EXTEND | Keeps keyword/SERP research (classified PROVIDER_RESTRICTED) and SEO suggestions; product facts move to PKB claims. |
| `lib/search`, `product_search`, triggers, tiers, typo correction | EXTEND | Engine stays in Postgres (D-026 reaffirmed); index and facets read PKB facts; aliases and query understanding added. |
| `search_synonyms` | REUSE | Term-level synonyms. Entity aliases are separate. |
| `search_queries`, `search_clicks` | EXTEND | More privacy-safe events (filters, refinements, add-to-cart after search). |
| `search_history` | REUSE, isolated | Customer-owned personal data. Never feeds the PKB except as aggregated, thresholded counts. |
| `lib/seo.ts` structured data | EXTEND | ProductGroup, per-variant offers, identifiers, images; description from visible content (F7). |
| `app/sitemap.ts`, `app/robots.ts` | EXTEND | Stage 4. |
| Jobs, cache tags, audit log, permissions, observability, migrator | REUSE | Extended with new job kinds, entity types and one permission. |

Nothing was removed in Stage 1.

### 3.3 Findings recorded during the audit

These are defects or gaps in the systems this programme touches. None was
fixed in Stage 1; each names the stage that owns it.

| # | Finding | Evidence | Owner stage |
| --- | --- | --- | --- |
| F1 | SeoPulse fill copies brand, `details`, category specifications, country of origin and the identifier into an empty `spec_table`, and measurable `details` into an empty `measurements`. The product page already renders those same sources, so a filled listing shows each such row twice (e.g. "Brand"). Two stores now hold one fact. | `lib/seo-pulse/facts.ts` `specificationRows`/`measurementRows`; `service.ts` fill `rows(...)`; `products/[slug]/page.tsx` spec assembly. Latent in dev data (every product already has a `spec_table`, no runs). | **Closed for fill in Stage 2**; apply path retired in 3 |
| F2 | Fill writes generated description and, with Claude configured, generated key features straight into empty fields of possibly published listings, with no per-field review. | `fillWithSeoPulse` | 3 |
| F3 | Apply is several independent writes (product save, each alt text, each synonym, the run marker, audit) outside one transaction; a failure part-way leaves a partial apply. | `applySeoPulse` | 3 |
| F4 | Research (including the AI and DataForSEO calls) runs inside the admin HTTP request. | `runSeoPulse` | 3, 7 |
| F5 (CLOSED, Stage 4) | Renaming a product changes its URL. The Basics panel sends `title` without `slug`, and `updateProduct` rebuilds the slug whenever the title changes, including on published listings; applying SeoPulse's H1 does the same. There is no redirect table, so the old address 404s. | `basics-section.tsx` payload; `updateProduct` slug rule | 4 |
| F6 (CLOSED, Stage 4) | `canonical_url` accepts any http(s) address, including another domain. | `httpUrl` in `lib/validation/catalog.ts` | 4 |
| F7 (CLOSED, Stage 4) | Product structured data takes `description` from the meta description, which is not visible on the page; carries no SKU/GTIN/MPN, no variants (`ProductGroup`), one image, one offer. | `lib/seo.ts`, product page | 4 |
| F8 | `updateProduct` reads the current row outside its transaction without a lock, so two concurrent saves can lose an update and record stale audit "before" values. | `lib/catalog/products.ts` | 7 |
| F9 (CLOSED, Stage 4) | The `product.updated` audit entry records only title, status, slug, searchable and boost; SEO and content field changes leave no before/after. | `updateProduct` | 4 — `seo_field_history` now keeps both |
| F10 (CLOSED, Stage 5) | Brand has no identity; spelling variants cannot be reconciled and the brand facet splits them. | schema | 2, 5 — `pkb_brands` since Stage 2; the storefront brand facet groups by the brand entity since Stage 5 (D-090) |
| F11 (CLOSED, Stage 5) | Category specification units are free text and values raw strings; "256GB" and "256 GB" are different facet values and never compare numerically. | `category_attributes`, facets SQL | 5 — `product_search_attributes` compares the canonical number (D-090) |
| F12 (CLOSED, Stage 5) | Option names are free text per product; "Color" and "Colour" become two filters. | D-030, facets | 5 — one attribute definition, with every older URL key still accepted (D-090) |
| F13 (CLOSED, Stage 4) | SeoPulse's "Optimization Score" and "Internal Search Score" are weighted 0–100 numbers; the brief rules out score-like ranking figures. | `lib/seo-pulse/scores.ts`, retired for `lib/seo/readiness.ts` | 4 |
| F14 (PARTLY CLOSED, Stage 5) | `search_keywords` mixes aliases, AI-suggested misspellings, phrases and brand variations with no provenance; once stored, the AI label is lost. | fill merge | 5 — entity aliases now live in `pkb_aliases` with a kind, an origin and an approval (D-067, D-089). `search_keywords` still exists as listing-level legacy text and is still indexed; it is contracted in Stage 7 |
| F15 (CLOSED, Stage 4) | Sitemap lists every category including empty ones; no image entries; a product's `lastModified` ignores variant and photo changes. | `app/sitemap.ts` | 4 |
| F16 (CLOSED, Stage 4) | SeoPulse decides a variant is available without the closing-date and D-058 rules the storefront uses, so schema readiness can disagree with the page. | `loadPulseInput`; the page's schema now uses `stockState` | 4 |
| F17 (OPEN, found Stage 7) | A listing or shelf address that does not exist answers 200 with `<meta name="robots" content="noindex">` rather than 404. Cache Components (D-054) stream a static shell, so the status is committed before `notFound()` fires. | `app/(storefront)/products/[slug]/page.tsx`, `categories/[slug]/page.tsx` | Deferred with a reason (D-108, R-18); a real status needs the existence check in `proxy` |

---

## 3A. Stage 2 — what was done

Built the Product Knowledge Base foundation and connected it to the existing
catalogue without changing what shoppers or staff see.

**Before starting**, the owner revised two Stage 1 assumptions (A-4
verification is evidence-policy driven, not manufacturer-only; A-6 source
acquisition is provider-agnostic). Recorded in sections 4.5, 4.8, 7 and in
D-063 and D-066.

### 3A.1 Built

| Area | Where | What |
| --- | --- | --- |
| Schema | `db/migrations/0031_product_knowledge_base.sql`, `db/schema/pkb.ts` | 19 `pkb_*` tables, 4 domains, link columns on `products`, `product_variants`, `attributes`, `categories`; the database rules listed in DATABASE.md (VERIFIED needs an evidenced claim and a decision basis; LEGACY ⇔ UNKNOWN_LEGACY; value shape per definition; single-valued slots; append-only history; no AI source type; AI-assisted evidence must quote; one GTIN per product; active schemas immutable; family cycles; assignment only to approved families). Triggers queue listings when mirrored columns change — never price, stock or capacity. |
| Normalization | `lib/pkb/decimal.ts`, `units.ts`, `normalize.ts`, `identifiers.ts` | Exact decimal arithmetic; 20 unit dimensions with canonical units; quantities, ranges, numbers, booleans, ISO dates, URLs, enums with aliases, brands; GTIN-8/12/13/14 with check digits and GTIN-14 equivalence, ISBN-10/13, MPN/model-number folding, ASIN. Refuses rather than guesses; raw text always kept. |
| Vocabulary | `lib/pkb/vocabulary.ts` | 21 system definitions (brand, manufacturer, model, generation, product type, release date, material, colour, size, dimensions, weights, box contents, country of origin …); exact label/key/alias matching; ambiguity reported, never resolved by guess. |
| Families | `lib/pkb/families.ts` | Suggest (catalog.manage), approve/reject/version/activate (knowledge.manage), assign; inherited schema resolution; the category-specification mirror (one definition per specification, one family per category that defines any, a new version per change). |
| Facts | `lib/pkb/store.ts`, `facts.ts` | Insert/update/delete with history; `setFact`, `clearFact`, `lockFact`, `unlockFact`; slot states (VERIFIED, MANUAL, UNVERIFIED, LEGACY, LOCKED, SUGGESTED, CONFLICT, NOT_APPLICABLE, UNKNOWN) and completeness against the family. |
| Mirror | `lib/pkb/sync.ts`, `projection.ts` | D-070: every staff write path syncs in its own transaction with attribution; unattributed changes via queue and job; locks and decided values protected; projection writes knowledge-native values back to the listing; unplaceable values parked in `pkb_unmapped_values`. |
| Provenance | `lib/pkb/evidence.ts` | Sources (with acquisition method, authority tier, origin, usage rights; deduplicated by address and content), evidence, fact claims (SUGGESTED/CONFLICT, conflicts mark each other, decided values untouched). Accept/reject is Stage 3. |
| Relationships, aliases, export | `lib/pkb/relationships.ts`, `aliases.ts`, `export.ts` | Directed and symmetric relationships with inverse labels; alias suggestion and approval by the vocabulary's owner; the export-eligibility rule. |
| Operations | `lib/pkb/maintenance.ts`, `db/pkb-backfill.ts`, `lib/jobs/registry.ts` | `npm run pkb:backfill` (import + reconciliation report, exit 1 unless clean), `pkb.sync_listings` job every 5 minutes, release of a deleted listing's purely mirrored knowledge; `db:setup` imports seeded listings. |
| Wiring | `lib/catalog/{products,product-lifecycle,variants,category-attributes,categories}.ts` | Product create/update/duplicate/delete, variant generate/add/remove, category and specification create/update/delete call the mirror. |
| Permission | `lib/auth/authorize.ts`, `app/admin/staff/page.tsx` | `knowledge.manage` for owner, operations manager, product manager. |
| F1 | `lib/seo-pulse/service.ts` | One-click fill no longer copies facts into `spec_table` / `measurements`. |

Not built in Stage 2, by design: any admin screen for the knowledge base (the
Product Intelligence view is Stage 3), claim acceptance and the verification
policy engine (Stage 3), source retrieval (Stage 3), readers moving off the
legacy columns (Stages 4–5).

### 3A.2 Schema as built versus section 4.4

- Added `pkb_legacy_attribute_map` and `pkb_sync_queue` (needed by the mirror).
- Data types are text, number, quantity, quantity_range, boolean, enum, date,
  url, brand, with a separate `cardinality` (single/multiple); "multi_enum" is
  enum + multiple.
- `value_status` (normalized / unnormalized / not_applicable) makes UNKNOWN the
  absence of a row, and lets an unreadable value be stored raw.
- Brand is a fact of type `brand` referencing `pkb_brands`, not a column on
  `pkb_products`, so it carries provenance like every other value.
- `pkb_products.name` follows the listing title until set by hand
  (`name_source`).
- Identifier changes have no history table of their own yet (facts do);
  recorded as risk R-6.

### 3A.3 Measured

| Measurement | Result |
| --- | --- |
| Migration 0031 on `manifest_scale` (5,000 products, 18,731 variants, 100,000 orders) | 2.6 s including 0030 |
| First import, `manifest_scale` | 5,000 listings, 18,731 offers, 38,731 LEGACY facts, 150 families, 60 brands, 0 failures, 176 s (≈35 ms per listing); reconciliation clean |
| Second import (all no-ops) | 114 s; nothing written; reconciliation clean |
| One product save, write only vs write + staff sync (20 of the most-variant products) | 8 ms → 36 ms median |
| No-op sync of one listing | 27 ms median (mostly loading the vocabulary; Stage 7 optimisation) |
| `updateProduct` on the most-variant products (≈250 variants), full path | 122 ms median, 424 ms worst |
| Development database `preorder` | migrated; 24 listings, 26 offers, 42 LEGACY facts, 2 families, 13 brands; reconciliation clean in 0.6 s; 69 hand-typed specification rows and 2 option values parked for mapping; 1 seeded UPC has a wrong check digit and is stored as invalid |
| Real admin API save on the running dev site | edited value became MANUAL with the admin as decider; untouched values stayed LEGACY; queue empty; storefront showed the saved text |

### 3A.4 Found and fixed on the way

- `updateProduct` computed a new slug through the shared connection inside its
  transaction; on the single-connection test database that waits forever once
  the transaction has issued a statement. Moved before the transaction (same
  behaviour, it was never locked).
- The local PostgreSQL server is WIN1252; `→` in migration comments could not
  be stored. Replaced before the migration was applied anywhere.

---

## 3B. Stage 3 — what was done

Product intelligence: the machinery that turns a source into a reviewed fact,
and the screens a person uses to decide. Nothing in this stage writes a fact
without a person naming the claim.

### 3B.1 Built

| Area | What exists now |
| --- | --- |
| Resolution | `lib/pkb/resolution.ts`: VERIFIED / HIGH_CONFIDENCE / AMBIGUOUS / UNRESOLVED from the product's own identifiers, sticky while the identity signature is unchanged; `confirmIdentity` with a required note and explicit distinctions; `canEnrich` gates every factual run (D-072) |
| Trust | `lib/pkb/trust.ts` and `policies.ts`: the Brand Source Registry (domains, path prefixes, providers, roles, tiers, address templates), brand relations, and four verification policies; `evaluateVerification` decides whether a claim may become VERIFIED, by source type, registry role, tier and independent sources (A-9) |
| Label mappings | `lib/pkb/mappings.ts`: the reviewed workflow, scoped by context and family, applied deterministically by `resolveLabel` inside the sync for details keys, the two tables and variant options; deciding or retiring a mapping re-queues the listings it touches (A-8) |
| Attribute discovery | `lib/pkb/discovery.ts`: proposals with a guessed shape and their evidence; Add to Family (through the category for a mirrored family, otherwise a new family version), Product only, Ignore — each remembering the label and creating a claim (D-073) |
| Enrichment | `lib/pkb/enrichment.ts`: runs in the `pkb.enrich_product` job; sources from the registry, staff URLs, provided documents and an optional research provider that reports NOT_CONFIGURED; retrieval through `safeFetch` and robots.txt; identity verdict per document; claims and proposals, never facts (D-074) |
| Extraction | `lib/pkb/extract.ts`: schema.org JSON-LD, two-cell HTML table rows, definition lists and labelled text lines, with a locator and an excerpt for each pair; no script execution |
| Network safety | `lib/pkb/net/`: address policy, pinned DNS, manual redirects, timeouts, size caps, content-type allowlist, RFC 9309 robots.txt where unreachable means disallowed |
| Review | `lib/pkb/review.ts`: create, accept (optionally as verified), reject, correct, resolve a conflict, lock — named claims, one transaction, no "apply everything" (D-076) |
| Identifiers | `pkb_identifier_history` through `insertIdentifier`/`updateIdentifier`/`deleteIdentifier`; an invalid identifier keeps its text and is marked, never corrected (R-6) |
| SeoPulse | Fill proposes generated wording instead of writing it; an apply is one transaction; research with an external provider runs as a job; `spec_table`/`measurements` removed from the apply fields (F1–F4, D-075) |
| Admin | `/admin/knowledge` (queue, label mapping, registry, policies, brand relations) and `/admin/products/[id]/intelligence` (identity, completeness, claims with evidence and verification eligibility, discovered attributes, sources, runs); seven API routes, each `refuseNonStaff()` first |
| Permissions | Reading intelligence needs `catalog.manage`; deciding vocabulary or trust needs `knowledge.manage`; both are checked server-side in the service functions, not in the screens |

### 3B.2 Tested

`tests/pkb-intelligence.test.ts` (24) and `tests/pkb-write-paths.test.ts` (2),
plus the Stage 2 suites re-run unchanged: resolution and the enrichment gate,
the label workflow and its reuse on a second listing, a registry entry with no
authority until approved, verification under and without a policy, a policy
turned off, conflicts and their resolution, all-or-nothing approval, attribute
discovery end to end, identifier history and an invalid check digit, a provided
document producing claims and proposals, and identity match / mismatch /
unknown. `tests/seo-pulse.test.ts` (40) was updated for job-based research.

### 3B.3 Found and fixed on the way

- `requestEnrichment` trusted the stored resolution state; it now re-checks it,
  because identifiers change between runs.
- Threading one transaction through the SeoPulse apply meant `updateProduct`,
  `updateProductImageAltText` and `createSynonym` needed an optional executor;
  each computes its pre-transaction reads through the same executor so it sees
  its own writes (PGlite has one connection).
- `createCategoryAttribute` was split into an in-transaction half
  (`createCategoryAttributeIn`) so attribute discovery can extend a category
  and write the claim in one decision.
- The label queue is grouped in TypeScript, not SQL: `labelKey` folds accents,
  punctuation and `&`, which SQL cannot reproduce, and a divergence would place
  a value under the wrong attribute.

## 3C. Stage 4 — what was done

The SEO engine: the shop's own pages state what it actually knows, and the
screens say what is measurably missing.

### 3C.1 Built

| Area | What exists now |
| --- | --- |
| Field states and locks | `seo_field_states` and `lib/seo/fields.ts`: AUTO, SUGGESTED, MANUAL, LOCKED per field; `seo_field_history` keeps before and after with the actor and reason; an automatic path is refused on a locked field, and a staff save is recorded as a decision (D-077, findings F9) |
| Addresses | `products.first_published_at` plus `product_slug_redirects` and `lib/seo/redirects.ts`: the address follows the title only while the listing is an unseen draft, and every address it leaves answers with a permanent redirect (D-078, finding F5) |
| Canonical | `canonicalUrlField` in `lib/validation/catalog.ts`: a path, or an absolute address on this site's origin. Another domain is refused (D-079, finding F6) |
| Structured data | `lib/seo/structured-data.ts` with `lib/pkb/publish.ts`: Product or ProductGroup, one Offer per variant with its own price and availability from `stockState`, identifiers and brand only when VERIFIED or staff-entered, description from the visible copy, `AggregateOffer` for a range, `CollectionPage`/`ItemList` for a category (D-080, findings F7 and F16) |
| Readiness | `lib/seo/readiness.ts` replaces the weighted scores: each check states a fact and its fix, with a severity in words; runs record checks passed out of checks made (D-081, finding F13) |
| SEO Health Center | `lib/seo/health.ts` behind `/admin/seo-health`: twelve counts from queries over published listings, each with examples, plus what a rich result can currently say across the catalogue |
| Sitemap | `app/sitemap.ts`: empty categories and hidden listings left out, `lastModified` from the listing, its photographs and its offers, gallery images as image entries (D-082, finding F15) |
| Internal links | `lib/seo/links.ts`: accessory, compatibility, series and successor links from accepted relationships, rendered on the product page only when they point at a public listing (D-083) |
| Admin | The product editor gains a readiness panel with per-field locks and the addresses the listing has had; `/admin/seo-health` is in the navigation; one API route for locking (`refuseNonStaff()` first) |

### 3C.1b Built in the second half of the stage

The first half covered field states, addresses, structured data, readiness, the
Health Center, the sitemap and internal links. The rest of the stage's scope —
technical auditing, image SEO, duplicate and thin content, and shelf SEO — is
built here.

| Area | What exists now |
| --- | --- |
| Shelf SEO | Migration 0035 adds `seo_meta_title`, `seo_meta_description`, `seo_no_index`, `canonical_url` and `intro_html` to `categories`; the shelf page uses them, the sitemap leaves a hidden shelf out, and the category tree edits them. The absent-means-leave-alone rule stops a rename wiping the copy (D-084) |
| Image SEO | `lib/seo/images.ts`: per listing, a photograph with no description, two photographs described identically, a file under 800px, a file over 600 KB, a file with no recorded size; the same checks counted over the catalogue; `suggestAltText` builds a sentence only from established values and never describes the picture (D-085) |
| Duplicate and thin content | `lib/seo/duplicates.ts`: exact groups on SEO title, meta description, product name and description body; bodies that open identically and diverge later; thin pages by what is on them; shelves still relying on the generated sentence. Index-backed, never pairwise, never rewritten (D-086) |
| Technical auditing | `lib/seo/technical.ts`: why a page is or is not indexed, a canonical pointing elsewhere, an old address taken over by a live listing, a redirect that now leads to a draft, a hidden shelf above an indexable listing, an address under a robots.txt disallow, a page with no offer; plus the catalogue-wide counts (D-087) |
| Link intelligence | `linkIntelligence` in `lib/seo/links.ts`: listings nothing links to, accepted relationships that cannot be rendered, and pairs sharing an established brand and family with no relationship — suggestions only (D-088) |
| Admin | `/admin/seo-health` gains four sections (crawlability, photography, shared wording, links); the product editor gains a **Page audit** panel from `lib/seo/audit.ts`, which checks `catalog.manage` itself rather than relying on the screen |

### 3C.2 Tested

`tests/seo-audit.test.ts` (11) covers the second half: the image findings and
that looking changes no alt text, the catalogue counts ignoring drafts, an alt
suggestion built only from established values, duplicate groups and a shared
opening told apart from a copy, thin pages and shelves with no copy, why a page
is not indexed, a shadowed redirect, empty and hidden shelves, orphan counts
before and after a relationship, a relationship that leads nowhere, and shelf
SEO surviving a rename with its HTML reduced to the allow-list.

Re-run unchanged: `seo-engine` (14), `seo-pulse` (40), `seo`, `catalog`,
`migrations`, `pkb-write-paths` — 98 tests in six files. Migration 0035 was
applied to the dev database, and the four new modules were run against it: 24
indexable listings, 12 shelves with no copy of their own, 26 photographs with
no recorded size (the seed never went through the media registry), 2 thin
listings, 24 listings nothing links to. The admin screens and a shelf save were
exercised on the running dev site: the Page audit panel and the four new health
sections render, and a saved shelf title and paragraph appear on the storefront
with a `<script>` stripped.

Earlier in the stage: `tests/seo-engine.test.ts` (14) plus the readiness checks in
`tests/seo-pulse.test.ts`. `e2e/seo.spec.ts` was updated for ProductGroup and
image entries but was not run in this stage. The rendered structured data was
checked by hand against the dev server: a two-variant listing produced one
`ProductGroup`, two variant `Product`s and two `Offer`s whose availability
differed (PreOrder and SoldOut), which is finding F16 closed in practice.

### 3C.3 Found and fixed on the way

- Nothing recorded whether a listing had ever been public: `publish_at` is a
  schedule and `status` can go back to draft. Migration 0034 adds
  `first_published_at`, which is what makes the address rule safe.
- The mirror credits a save only with what it changes (D-070), so re-saving an
  identifier unchanged leaves it LEGACY and therefore unpublishable. That is
  correct, and worth knowing: a legacy value becomes publishable when someone
  actually corrects it, or accepts a claim for it.
- `lib/seo.ts` became `lib/seo/index.ts` so the engine could be several files
  without changing a single import.
- Near-duplicate detection was nearly given its own fingerprint table. It was
  not: a derived table has to be kept in step with every copy edit, and a stale
  fingerprint reports a duplicate that is not there. Bucketing on the opening of
  the stripped body, with an index on that expression, needs nothing kept in
  step and can be checked by hand in SQL.
- The broken-link query first used a filtered `left join`, which made "no
  listing at all" and "a listing shoppers cannot reach" indistinguishable. The
  join is now unfiltered and the reason is decided afterwards, because those two
  are different problems with different fixes.
- Category reads were three different column lists in three functions; they are
  now one `CATEGORY_COLUMNS`, so a new column cannot reach one caller and not
  another.

## 3D. Stage 5 — what was done

SearchPulse now reads the Product Knowledge Base. The storefront's search and
filters answer the same questions they did before, plus the ones the listing's
own columns could never answer, and nothing about a product is stored twice.

### 3D.1 Built

| Area | Where | What |
| --- | --- | --- |
| Index | `db/migrations/0036_search_knowledge.sql` | `product_search` gains `brand_key`, `family_keys`, `alias_keys` and `terms`; `refresh_product_search` builds them from `pkb_facts`, `pkb_identifiers`, `pkb_aliases`, `pkb_brands` and `pkb_families`, keeping every 0014 source beside them (D-089, D-095) |
| Facet read model | same migration, `refresh_product_search_attributes` | `product_search_attributes`: one row per product, attribute and value, from the knowledge base where it has the value and from the listing's option groups and category specifications where it does not, each row saying which (D-090) |
| Comparison forms | `search_term_key`, `search_number` in SQL; `lib/search/terms.ts` in TypeScript | The two forms a query and an indexed value must agree on. Quantities are normalized once, by `lib/pkb/units.ts`, at write time — there is no second unit registry (D-089) |
| Query understanding | `lib/search/knowledge.ts`, `plan.ts`, `synonyms.ts`, `normalize.ts` | One indexed lookup per search turns phrases into brands, families, products and controlled values; quantities are parsed from the search as typed, so "6.1 inch" survives tokenisation; a slot matches through its words *or* its terms |
| Matching and ranking | `lib/search/sql.ts` | `searchMatch` gains the terms alternative; `relevanceTier` gains tier 10 for a whole-query product alias and judges the rest on the readable part of the search (D-091) |
| Facets and filters | `lib/catalog/facets.ts`, `filter-params.ts`, `components/discovery-results.tsx` | Filters, counts and facet lists read the read model; incoming URL keys and values are resolved to their canonical pair, with every older key still accepted; the brand control groups by brand entity |
| Autocomplete | `lib/search/suggest.ts` | Brands from the knowledge base, grouped by entity; approved aliases suggesting the name they stand for (D-092) |
| Analytics | `db/schema/search.ts`, `lib/search/events.ts`, `attribution.ts` | `search_events` for filters, refinements, add-to-cart and purchase; a short-lived first-party cookie carries a search from the result a shopper opened to the order they pay for, and the phrase is erased the moment it is counted (D-093) |
| Zero-result intelligence | `lib/search/zero-results.ts`, `app/admin/search/zero-results.tsx` | Seven verdicts with their evidence and a recommendation; an alias can be *proposed*, never recorded automatically (D-094) |
| Admin | `app/admin/search/page.tsx`, `app/api/admin/search/aliases/route.ts` | Four new measures on the search report, carts and purchases per query, and the zero-result verdicts; the alias route checks the permission inside `lib/pkb`, not in the screen |

Not built in Stage 5, by design: Search Console (Stage 6), removal of the
legacy option and specification paths (Stage 7, D-095), and any change to
`search_synonyms`, `search_history` or the typo vocabulary.

**Relationships are deliberately not a search signal.** The brief allows
"product relationships where relevant", and `pkb_relationships` holds accepted
accessory, compatibility, series and successor links. They are not indexed.
Letting a search for one product also return everything related to it makes the
results *less* relevant, not more: someone searching for headphones is shown
cases, and someone searching for a case is shown headphones. Relationships
already do the useful version of this on the product page, where the context is
"things that go with *this*" rather than "things that answer your search"
(D-083). If the owner wants related products under a results page later, that
is a merchandising row beneath the results, not a change to what matches — and
it should be built as such.

### 3D.2 Search architecture, before and after

| | Before | After |
| --- | --- | --- |
| Index source | `products` columns: `brand`, `details`, `attribute_values` JSON, `spec_table`, variant option values, category specifications | the same, **plus** accepted knowledge facts, trade identifiers, approved aliases, the brand entity and the family lineage |
| Brand | the exact string on the listing | the knowledge base's brand entity, with the listing's string as a fallback |
| Attribute values | raw strings, compared with `lower()` | typed and normalized at write time; compared on a canonical key |
| Quantities | text; "256GB" and "256 GB" never compared | one canonical number of bytes, whichever way either side is written |
| Filter identity | `search_slug(name)` per attribute, per system | one attribute definition, with every older key kept as an alias |
| Aliases | none; `search_keywords` free text | approved `pkb_aliases`, widening the text side and matching a structured term |
| Ranking | nine tiers (D-027) | eleven: an approved whole-query alias at the top, an attribute-only match at the bottom, the nine unchanged between |
| Typo tolerance | trigram correction over the listing vocabulary | unchanged, plus approved misspelling aliases, which match directly instead of needing a correction notice |
| Facets | two correlated subqueries over JSON and option tables, per facet | one indexed read of `product_search_attributes` |
| Analytics | queries and clicks | plus filters, refinements, add-to-cart and confirmed-payment attribution |
| Zero results | a list of words | a verdict, its evidence and a recommendation |

### 3D.3 Tested

`tests/search-knowledge.test.ts` (54) is the new regression cover: term-key
parity between SQL and TypeScript over nine inputs including accents and
punctuation; a quantity normalizing identically from "256gb", "256 GB" and
"256 gigabytes"; "2 in 1" *not* being read as a length; exact title, exact
model in three punctuations, a UPC and its GTIN-14 form, brand, family name and
family key; an attribute value and two attributes at once; an alias finding
nothing until approved and nothing again once the approval is taken away; an
alias inside a longer search not naming that product; an exact product above a
listing that merely shares its colour; an exact model above five broad
attribute matches; the staff boost still unable to lift a weaker match; a typed
quantity not flattening the ranking; a prefix needing no correction and a real
misspelling getting one; one filter from two spellings of one attribute; a
value filtered however the link spells it; a brand spelled twice counted once;
meaningless attributes not offered; sixty variants counted once; autocomplete
from names, brands and aliases; a listing with no knowledge beyond its title;
the seven zero-result verdicts and the two human steps before an alias exists;
filter events keeping keys and not values; a refinement against the search it
replaced; a personal-looking search recorded nowhere; a conversion counted once
and erased; and the index following a knowledge change, a retired knowledge
product and a brand key.

Re-run unchanged: `search-engine` (25), `search` , `search-index`,
`search-analytics`, `facets`, `discovery`, `filter-chips`, `catalog`,
`migrations`, `schema`, `checkout`, `product-details`.

One existing test was updated rather than weakened: `discovery.test.ts` asserted
that a RAM facet's URL value was the bare number `8`. The value now travels as
the label it is shown under, `8 GB`, and the bare number still filters — both
are asserted, so the case is strictly stronger than it was.

### 3D.4 Found and fixed on the way

- A quantity typed without a space ("256gb") matched neither a listing whose
  text says "256 GB" nor one whose knowledge value is in bytes, because the
  tokeniser makes it one word. A structural slot now carries both written forms
  as alternatives as well as the canonical term, so it finds a listing whose
  value the knowledge base has never seen.
- Reading a unit out of any number-then-letters pair turns "2 in 1 case" into a
  50.8 mm length. A unit written apart from its number now has to be at least
  two letters and not an English stop word; a unit written against it is always
  taken.
- The facet value's URL form had to change (a quantity's identity is its
  canonical number, not its spelling), which would have broken shared links.
  Both the attribute key and the value key keep every older form they answered
  to, resolved before anything else sees the filter.
- `ensureSystemDefinitions` seeds vocabulary aliases, so `pkb_aliases` is never
  empty. A test asserting "no alias was created" has to name the alias.
- A trigger function that reads `OLD` and `NEW` in one expression fails on the
  operation that has only one of them. Each is read under its own branch.
- On the running dev site, one specification read "16 – 300 ohm ohm". A
  category specification whose unit the registry does not know ("ohm") becomes
  a plain number with a display unit; the value staff typed already carried the
  unit, and the code put it back a second time. How a stored value reads is now
  one SQL function, `value_reads`, shared by the document and the filter, and
  it appends the display unit only when the value does not already end with it.
  Two places computing the same wording was the actual defect; one of them
  having a bug was the symptom.
- The migration's final rebuild was one call over the whole catalogue, as
  migration 0014's was. The builder now reads eight more tables, and at 5,000
  listings that one call took 71 seconds while holding every row it touched. It
  is now batched at 200, which is the same total work in pieces short enough
  that a large catalogue does not turn the migration into a long lock.

### 3D.5 Measured

Development database `preorder` (24 listings, 26 offers) and `manifest_scale`
(5,000 listings, 18,731 offers, 100,000 orders), both real PostgreSQL. Medians
over repeated runs, after a warm-up.

| Measurement | `preorder` | `manifest_scale` |
| --- | --- | --- |
| Migration 0036 end to end, including the rebuild | 1.6 s | 17.6 s |
| Facet read model built | 44 rows, 24 listings | 38,762 rows, 5,000 listings |
| Rebuild one listing (the 20 most-variant) | — | 43 ms (worst 132 ms) |
| Rebuild a chunk of 200 | — | 565 ms (worst 1.6 s) |
| Rebuild the whole catalogue in one call | 53 ms | 71 s — why the migration batches |
| Search: plan, count and one page of 24 | 4–11 ms | 26–79 ms |
| Facets for a search | 8–13 ms | 24–201 ms |
| Facets with no search (the whole catalogue) | 4 ms | 289 ms |

The facet query is the one directly comparable before-and-after, because the
pre-0036 query still runs against the same data:

| Facet values over the whole public catalogue | `manifest_scale` |
| --- | --- |
| The query migration 0036 replaced (two subqueries over JSON and the option tables) | 377 ms |
| The read model | **107 ms** |

So the storefront's most expensive facet read is about three and a half times
faster than it was, on the same data, while answering a harder question — one
attribute where there used to be two, and quantities compared as numbers.

What got more expensive is rebuilding: one listing costs 43 ms at scale, paid
by the deferred trigger at the commit of whatever changed it. `rebuildSearchIndex`
already chunks by 200, so the admin button costs about 14 s at 5,000 listings
rather than 71. Recorded as R-12.

## 3E. Stage 6 — what was done

Search Console as an optional intelligence source, an opportunity engine over
what it measures, one SEO change history, before-and-after observation, and
controlled learning that recommends and never teaches.

**The whole stage works with Search Console not connected.** That is the
governing constraint, not a fallback: with no provider configured every entry
point answers "Search Console not connected", the sync refuses with an
explanation and writes nothing, the opportunity engine returns an empty report
rather than a screen of zeroes, and the SEO change history — which is the shop's
own record — carries on working. Nothing in SeoPulse, SearchPulse, the storefront
or the Product Knowledge Base depends on it.

### 3E.1 Built

| Area | Where | What |
| --- | --- | --- |
| Provider boundary | `lib/providers/search-console/` | `SearchConsoleProvider`: what is configured (no network call, so a screen renders its state without waiting on Google) and one page of performance rows. `UnconfiguredSearchConsoleProvider` is the default and reports `NOT_CONFIGURED`; `GoogleSearchConsoleProvider` is the only file that reads credentials — a service-account key signed into a JWT, exchanged for a short-lived access token, against the Search Analytics API with `dataState: "final"`. Selected by `SEARCH_CONSOLE_PROVIDER`; `setSearchConsoleProviderForTesting` swaps it (D-096) |
| Schema | `db/migrations/0037_search_console.sql`, `db/schema/search-console.ts` | `search_console_metrics` (keyed on property, day, dimension, page and query; `ctr` generated from the counts; `position` stored as reported), `search_console_syncs`, `search_console_sync_state`, `seo_opportunity_decisions`, and the widened `seo_field_history` |
| Synchronisation | `lib/search-console/sync.ts` | A requested row, a durable job (`seo.search_console_sync`), and a handler that can be retried freely. Idempotent by storage: an upsert on the natural key. Bounded by a request ceiling; paginated by row offset; a finished sync returns unchanged; the watermark moves only after a sync that stored its whole window. `seo.search_console_schedule` runs twice a day and reports rather than failing when nothing is configured |
| Address resolution | `lib/search-console/paths.ts` | A Search Console address becomes a path of this shop, a listing, a shelf, or nothing. Another site's address is dropped; an address this shop no longer serves resolves through Stage 4's redirect table; an unrecognised path is kept with no entity attached, because a page Google sends people to that this shop does not recognise is the problem worth seeing |
| Read model | `lib/search-console/metrics.ts` | Connection state, coverage, totals, per-page and per-query performance, and how many of a window's days are actually measured. Positions are impression-weighted; averaging the averages would let a page seen twice count as much as one seen ten thousand times |
| Opportunity engine | `lib/search-console/opportunities.ts` | Five kinds — shown and not clicked, a query the page never says, ranking within reach, a measurable fall, a measurable rise — each with its numbers and a recommendation. Thresholds are one exported constant. The click-through benchmark is **this site's own median per position band**, and a band with fewer than five qualifying pages produces no benchmark and is reported as insufficient data (D-097) |
| Decisions | same file, `seo_opportunity_decisions` | Acted, dismissed or watching, with the measurements as they stood. The finding is recomputed every read; the decision is a note on it |
| Change history | `lib/seo/history.ts`, `lib/catalog/categories.ts`, `lib/seo/fields.ts` | `seo_field_history` widened rather than duplicated (D-098): entity type, shelves, and the workflow that made the change. `updateCategory` now records shelf SEO changes, which had no history at all before |
| Before and after | `lib/search-console/comparison.ts` | The windows either side of one change, with the change day in neither. States what the numbers did and carries `causation: "not established"` and the confounders. Insufficient days, too little traffic, and a change too recent for a window after it are each their own verdict (D-099) |
| Controlled learning | `lib/search-console/learning.ts` | Recommendations from approved aliases, the internal search log, Search Console performance and the change history. A query never becomes a fact, an attribute, an alias or copy on its own; the guardrails are printed on the screen (D-100) |
| Admin | `app/admin/seo-performance/`, `app/admin/products/[productId]/search-performance-box.tsx`, two API routes | The connection and its diagnostics, a sync button, opportunities with per-finding decisions, improvements, insufficient-data notes, recommendations, and the change history with what happened after each change. The listing editor gains a compact box; both routes call `refuseNonStaff()` and the permission is checked inside `lib/` |
| Retention | `lib/search-console/sync.ts`, `lib/jobs/registry.ts` | `maintenance.prune` deletes measurements past `SEARCH_CONSOLE_RETENTION_DAYS` (480 by default) |

Not built in Stage 6, by design: any paid SEO provider (none is configured and
none is needed), a second change-history table, stored opportunity lists, and
any automatic write into the knowledge base.

### 3E.2 What the system will not say

The brief rules out invented figures, and the engine has no way to produce
them. Search volume, keyword difficulty, CPC, backlinks, competitor traffic and
competitor keyword counts are not measurements Manifest has, so they are absent
rather than estimated — a test asserts none of those words appears in a report.
There is no score. The click-through benchmark is the shop's own median, not a
published industry table, because a table is someone else's data presented as
this shop's measurement. And no comparison ever claims a change caused
anything: the wording is "clicks increased in the observed period after the
change", the `causation` field says "not established", and a test checks five
causal phrasings never appear.

### 3E.3 Tested

`tests/search-console.test.ts` (47), all against the fixture at the provider
boundary. Covered: the unconfigured path end to end; the Google provider's
unconfigured state and that its connection returns no key material; storing,
idempotency, revision in place, double-click dedupe, a retried job, pagination,
an outage leaving the watermark alone, the next window re-reading the trailing
days, address resolution including an old address, and the job through the real
registry; all five opportunity kinds plus both insufficient-data paths and the
forbidden-vocabulary check; decisions; listing and shelf history, the
append-only trigger refusing an update and a delete, and two changes keeping two
rows; before-and-after in both directions, the no-causation assertion, and a
change too recent; controlled learning recommending, writing nothing, and
stopping once an alias is approved; and every entry point refusing a customer
and a signed-out visitor. Details in `docs/TESTING.md`.

Re-run unchanged: `seo-engine` (14), `seo-audit` (11), `seo-pulse` (40),
`catalog`, `migrations`, `jobs`, `schema`, `pkb-write-paths`, `search-knowledge`
(54), `search-engine`, `seo`, `discovery`, `facets`, `env`, `observability` —
296 tests across sixteen files besides the new one. `npm run typecheck` and
`npm run lint` pass.

### 3E.4 Exercised on the running dev site

Migration 0037 was applied to the dev database and `npm run pkb:backfill --
--report` stayed clean. With nothing configured, `/admin/seo-performance`
renders "Search Console not connected" with the change history beside it, the
listing editor's box says the same, the sync route answers 409 with the
explanation, the decision route records one, and both routes answer 401 to a
signed-out caller. A shelf save through the real admin API wrote its change
history rows.

The connected screen was then exercised against a **dummy local property**: 476
fixture measurements over 56 days for 8 listings, with `SEARCH_CONSOLE_PROVIDER`
set and a deliberately invalid key. The screen showed the property, the coverage
and the last sync; the engine produced one "shown, not clicked" finding against
the site's own 7.50% median for positions 5 to 10, eight "within reach"
findings, one content gap ("shown 336 times for 'portable espresso maker', which
this page never says") and the matching alias recommendation. A sync with the
invalid key failed as `UNAVAILABLE` with a readable diagnostic, the watermark
did not move, and the job completed rather than retrying forever. The fixtures,
the environment entries and the scratch scripts were all removed afterwards; the
dev server is running on the restored configuration.

### 3E.5 Found and fixed on the way

- The first draft read queries through the site-level `query` dimension for both
  the content-gap rule and the alias recommendation, so neither could ever name
  a page. Both now read `page_query` explicitly, and `queryPerformance` groups by
  page as well as query rather than picking one page arbitrarily with `max()`.
- An alias is stored under the knowledge base's label key, which spaces words
  where the search term key underscores them. Comparing the two directly made
  every phrase look new, so an approved alias never silenced its recommendation.
  The comparison now uses `labelKey` on both sides.
- `changeFieldLabel` only knew the shelf fields, so a listing's change reached
  the screen as `seoFocusKeyword`. It now defers to `seoFieldLabel` for anything
  that is a listing field.
- An unreadable private key surfaced as OpenSSL's "DECODER
  routines::unsupported", which tells an operator nothing. Signing failures are
  now reported as an unreadable key, and the key itself is never quoted.
- `seo_field_history` is append-only in the database, so a test cannot backdate
  a change after writing it. The before-and-after fixtures insert the row with
  the date it is meant to have — which is what a change made that day would have
  written — rather than weakening the trigger.

## 3F. Stage 7 — what was done

Hardening. Nothing in this stage is new capability: it goes back over what
Stages 2 to 6 built and asks, of each part, who may call it, what happens when
two people save at the same moment, what it costs when the shop is large, and
whether an operator can see it working.

**Two things it did not do.** No legacy column was removed, because the database
says they are not ready (D-103), and `products.search_keywords` is kept by
decision rather than by inability (D-105). Both were planned for this stage; the
evidence said otherwise and the evidence is now on a screen.

### 3F.1 Security and permissions

| Area | Where | What |
| --- | --- | --- |
| Read separated from write | `lib/auth/authorize.ts`, the SEO and Search Console read models | `seo.view` gates every performance report; every action on those screens still needs `catalog.manage`. `analytics.view` was deliberately not reused — it gates the purchase funnel and customer behaviour, and granting it to show page performance would have opened both (D-101) |
| Addresses judged, not matched | `lib/pkb/net.ts` | An IPv6 address is expanded to its eight groups before any rule applies; an embedded IPv4 address, mapped or compatible, is judged by the IPv4 rules; a zone index is refused; an unparseable address is refused rather than assumed public. `::127.0.0.1` and `::169.254.169.254` used to be treated as public, and `::ffff:8.8.8.8` used to be refused (D-104) |
| Decompression bounded | `lib/pkb/net.ts` | `safeFetch` hands the size cap to zlib as `maxOutputLength` as well as counting bytes, so a single enormously expanding chunk is never allocated, and the refusal is `TOO_LARGE` rather than a network fault |
| Strict admin schemas | twelve knowledge and SEO routes, `tests/admin-api-schemas.test.ts` | An unexpected field is refused with 400 rather than stripped, which SECURITY.md has promised since Phase 14. The test is a source check, so it covers routes written later, along with the rule that a route refuses a non-staff caller before it reads the body |
| Rich text | `tests/rich-text-write-paths.test.ts` | Fails when any path stores `descriptionHtml` or `introHtml` without the allow-list sanitiser |
| Data boundaries | `tests/data-boundaries.test.ts` | Reads the live schema: no `pkb_*` column may carry a person or something they bought (`created_by` and `decided_by` are the deliberate exceptions), no `pkb_*` table may reference an order, cart, address or payment, nothing there is a second copy of what a shopper searched for, Search Console holds nothing identifying and appears in no export, and no file in `lib/seo` or `lib/search-console` assigns a search volume, keyword difficulty, cost per click or backlink count |

### 3F.2 Write safety

- **F8, a lost update on a listing save.** `updateProduct` read the row it
  derives its patch from *before* taking the listing's knowledge lock, so two
  concurrent saves each wrote back the other's untouched columns, recorded a
  stale "before" in the audit log and the SEO history, and could set
  `first_published_at` twice. The read now happens after the lock, inside the
  transaction; the checks that refuse a save outright stay outside it, because
  they read through the shared connection and a transaction must not wait on a
  second one.
- **The same shape again, on a guard.** `applySeoPulse` promises that a field
  which already has a value is never replaced unless the operator chose Replace.
  That check was made against a listing read outside the transaction, so two
  applies both passed it and the second overwrote the first. The check is asked
  twice — once before the transaction, so a staff member gets the answer without
  a lock being taken, and again inside it after `beginListingChange`. Re-reading
  inside the transaction was not enough on its own: the lock has to come first.
- **Option renames are attributed (R-8).** `renameProductOption` and
  `renameProductOptionValue` rename and re-read the knowledge base in one
  transaction, so the change belongs to whoever made it, gets a history row, and
  is refused where the value has been decided. The database trigger stays as the
  safety net for a write that arrives another way, and a test proves such a write
  cannot overwrite a decided value and is parked with a reason instead.
- **`enqueueUniquePending`** is new in the job runner, because `dedupeKey` cannot
  express "is this work already going to happen?" — its unique index is not
  scoped to a status, so a constant key is claimed by the first job for ever. The
  first implementation took the advisory lock in the same statement's `from`
  clause, which cannot work: under READ COMMITTED a statement takes its snapshot
  when it starts, and waiting on a lock does not refresh it, so twenty callers
  each saw nothing pending and each inserted. The check has to be a separate
  statement issued after the wait, and the broken version is kept in the tests as
  a control.

### 3F.3 Measured

| What | Before | After |
| --- | --- | --- |
| Whole-catalogue search rebuild, in the request | ~71,000 ms | 123 ms warm, 1,036 ms cold (a bounded insert; the work moves to `search.process_queue`) |
| The same work in the background, one worker | — | 15.4 s over 5 bounded passes |
| Per listing, drained in chunks of 200 | — | 3.08 ms |
| Knowledge backfill, 5,000 listings | 305 s | 181 s, with the listings queued for the worker (D-102) |
| Product save, one detail changed | 81 ms | 56 ms |
| Product save, nothing changed | 28 ms | 16 ms |
| Knowledge sync, one listing | 24 ms | 12 ms |
| Reconciliation report | 2,434 ms (10,024 statements) | 511 ms (54 statements) |
| SEO page audit, one listing | 197 ms | 6 ms |
| Opportunity report, 20,000 pages | 4,867 ms | 737 ms (D-107) |
| Deleting one listing's search events, 500,000 rows | 41.0 ms scanning | 0.6 ms indexed (D-106) |

All on the 5,000-listing `manifest_scale` database, except the opportunity
report and the delete, which need volumes the catalogue does not produce and
were measured on `manifest_bench` (1,120,000 measurements over 20,000
addresses) and on a 500,000-row scratch table. The harnesses are
`scripts/perf/knowledge-bench.ts`, `scripts/perf/search-rebuild-bench.ts` and
`scripts/perf/search-console-bench.ts`.

Two of those numbers came from finding the cost was not where it looked.
`loadDefinitions` asked for options and aliases with an IN list of every
definition id and joined them in JavaScript with a nested filter per row; the
reconciliation report loaded each listing's projection with two statements of its
own; the per-listing duplicate check compared with a CASE inside the join, which
no expression index can serve; and the opportunity engine's two expensive
aggregates were a per-group `count(distinct …)` and a per-row `numeric`
multiplication, not the scan they sat on.

### 3F.4 Observability

Every scheduled job already recorded what it did into `jobs.result` — how many
files the media sweep reclaimed, how many listings are left to reindex, what the
prune removed — and nothing read it back. `/api/admin/jobs` existed with no
screen consuming it, so an operator could see that the scheduler was alive and
that something had died, and nothing in between. `/admin/jobs` now shows each
job, how often it runs, when it last finished and what it reported, with the
failures and a retry for a dead one behind `settings.manage`. `jobSummary`'s
last-finished-run read is `distinct on (kind)` with a matching partial index,
because the every-minute delivery job alone leaves about ten thousand finished
rows inside its retention window.

`mediaCoverage` (R-11) separates the two kinds of photograph with no registry
row: the seeded development images, which are committed under `public/` and must
never gain a row — a row is what makes the sweep willing to delete a file — and
everything else, which is a file nothing can reclaim. `registerExistingMedia`
records what the configured provider says it stores; providers gained `keyFor` to
say so conservatively and `read` so the reconciliation can *measure* what it
records — dimensions, byte size, digest and content type come from the bytes via
sharp, never from the address, and stay null when the provider cannot hand the
file back.

The "stored measurements" panel (R-17) reports rows per property, the stored date
range, the size on disk as PostgreSQL reports it, the retention window, how many
rows the next prune will remove and when the last one ran — whether or not a
provider is configured, because rows outlive the configuration that fetched them.

### 3F.5 The legacy contract, decided on evidence

`legacyCoverage` counts, from the database, how much of each legacy catalogue
system the knowledge base actually holds, and shows it on the knowledge screen:

| Legacy system | Development database |
| --- | --- |
| Shelf specification definitions | 2 of 2 covered — contractable |
| Variant option groups | 2 of 5 covered — 3 unmatched |
| Variant option selections | 6 of 8 mirrored — 2 unmirrored |
| Listing search terms | Retained on purpose |

with 72 values parked, waiting for somebody to say what they are. `allCovered` is
the gate a contraction has to ask. Nothing is removed in this stage, because
removing `category_attributes` or the legacy option readers today would drop
values with no knowledge attribute behind them — the one failure the staged
migration exists to prevent. Invariants I-11 and I-12 therefore stand where
Stage 5 left them: the product page's Specification and Measurements tabs still
read the legacy columns, which the projection keeps in step (D-070).

`suggestAliasesFromKeywords` is the path out for search terms: a listing's terms
are offered as *suggested* product aliases, attributed to whoever asked, and
approving each one needs `search.manage`. Nothing is deleted, a rejected term is
never re-proposed, running it twice proposes nothing new, and the report says
what each term has become. A test asserts that the search-terms column is never
reported as contractable — not even on a database where every term has been
approved as an alias — because a report that said otherwise would eventually be
acted on.

### 3F.6 Migrations

| Migration | What |
| --- | --- |
| 0038 | Replaces the description index migration 0035 added (every caller trimmed before hashing, so the expressions never matched); adds the indexes the cascade and prune paths a listing save walks were missing; checks that an opportunity decision cannot name a listing while claiming to be about a shelf |
| 0039 | `product_search_queue.source`, so a rebuild can be left to the worker while a change is still rebuilt at its own commit |
| 0040 | Lets a transaction declare itself a bulk import with `set local manifest.search_queue_source` |
| 0041 | The five foreign-key indexes a delete actually scans, with the reason the other seventeen are left alone |

### 3F.7 Found and fixed on the way

- `tests/rich-text-write-paths.test.ts` caught a mistake in itself: an
  unanchored exclusion meant to skip the type `string | null` also matched the
  tail of `input.descriptionHtml || null`, so the guard passed while the
  sanitiser was removed. Every exclusion is anchored now, and the guard is
  confirmed to fail when the sanitiser is taken out.
- The production build had never been run in this repo, and it failed:
  `next/font/google` was asked for five separate weights of Figtree, which is a
  variable font, and Turbopack cannot express that as one query. One file carries
  every weight the design uses, so the list is gone and the typography is
  unchanged.
- The end-to-end suite had never been run either, and running it against the
  production build found a second-factor ceiling nothing could raise: ten
  attempts per address per fifteen minutes, hard-coded. A suite that signs a
  dozen accounts in from one address exhausts it, so several specs were refused
  with "too many attempts" and read it as a broken sign-in — reproducible under
  the full suite, absent when the spec ran alone. Both ceilings are configurable
  now, the per-account one stays at ten because that is the one that stops
  guessing, and only the address ceiling is raised for the test server.

## 3G. Stage 8 — what was done

The final audit. Nothing here is new capability either: it takes the whole
surface Stages 1 to 7 built and asks, of each part, whether the repository
actually does what the documents say, and whether the answer can be shown rather
than asserted. Five defects were found and fixed, one of them in the development
environment rather than in the code. Two questions the owner left open were
answered with measurements.

### 3G.1 Defects found and fixed

| # | What | How it was found | Fix | Regression test |
| --- | --- | --- | --- | --- |
| S8-1 | The development database's migration ledger disagreed with the repository: 0041 was applied, then edited before it was committed, so `jobs_kind_finished_idx` — the index the Background work screen's last-finished-run read depends on — had never been created. `manifest_bench` was in the same state | `npm run db:migrate` refused to run, which is exactly what the ledger is for (D-069) | 0041 replayed (every statement is `CREATE INDEX IF NOT EXISTS`) and the recorded checksum set to the committed file's, on both databases. No migration was edited | The ledger's own refusal, already covered by `tests/migrations.test.ts`; and a schema comparison against a database built from zero, recorded in 3G.2 |
| S8-2 | `refresh_product_search` built the search document in whatever order the plan produced: one unordered string aggregate over a listing's shelf specifications. Refreshing one listing and refreshing it inside a batch stored different documents for the same data — 3,863 of 5,000 on the scale database. Relevance within a tier uses `ts_rank_cd`, which reads positions out of the tsvector, so the same query could rank two listings differently because of how the index had last been rebuilt | Rebuilding the derived model from canonical data and comparing it with what was stored — the check section 6 of the Stage 8 brief asks for | Migration 0042: 0036's function with `ORDER BY d.sort_order, d.name, e.key` on that aggregate, and nothing else changed | `tests/search-document-order.test.ts`: one test reads the function as the database holds it and fails on any aggregate that can return rows in an arbitrary order, so it covers aggregates added later; one asserts the order, and that a single and a batched refresh agree |
| S8-3 | `/api/admin/knowledge/products/[id]/resolve` with `{"action":"refresh"}` reached `refreshResolution` directly, on the grounds that re-checking is a read. It is a write: it stores the resolution state, appends a history row, and where the state is no longer VERIFIED it clears `resolution_decided_by` and `resolution_decided_at` — a confirmed identity, discarded by any staff account, unattributed | Auditing every admin route against the permission each lib function it calls actually asks for | `reassessResolution(actor, id)`, which asks for `catalog.manage` — what every other resolution write asks for — and takes the row's lock first. The route calls that | `tests/pkb-intelligence.test.ts`: a staff account with `seo.view` but not `catalog.manage` is refused, the confirmed identity survives, and somebody who may manage the catalogue still can |
| S8-4 | `decideAlias` read the alias row outside its transaction and checked "still only suggested" against that read. Two decisions arriving together both passed and both wrote, so an approved alias — live search vocabulary — could become rejected, recorded against whoever committed last, with nothing on the row to say it had been decided twice. The third instance of the shape Stage 7 fixed twice (D-110) | Looking for the Stage 7 defect shape everywhere else it could be: a probe over `lib/` for a read on the shared connection, a guard, and then a transaction that writes | The row is read inside the transaction `for update`, and the update carries `status = 'suggested'` in its `where` as well | `tests/knowledge-decision-concurrency.test.ts`, on real PostgreSQL, confirmed to fail against the previous code — both decisions were fulfilled. Claim decisions are in the same file as the control, because they were already safe |
| S8-5 | Every prune in the hourly maintenance job deleted everything past its retention window in one statement and asked for an identifier back per row, only to count them. 500,000 Search Console measurements: 2,177 ms and 106 MB of live identifiers for rows that had just ceased to exist. That table's size is set by Google, not by this catalogue (R-17) | Measuring the thing the checklist calls "unbounded operations" rather than reasoning about it | `pruneInBatches` (`lib/prune.ts`, D-111), applied to search queries, search clicks, search events, Search Console measurements, rate-limit hits and finished jobs. Guest carts already batched, which is where the shape came from | `tests/prune.test.ts`: the count stays exact, the ceiling is reported as `more` rather than passed off as finished, and the batch size is bounded at both ends |

### 3G.2 What was verified, and how

| Question | Evidence |
| --- | --- |
| Is there a second canonical factual store? | No file outside `lib/pkb` writes a `pkb_*` table (source search); no trigger writes `pkb_facts`; `db/seed.ts` only truncates them. Every module under `lib/search-console`, `lib/search` and `lib/seo` imports only read models from `lib/pkb` (`common`, `publish`, `units`, `normalize`); `lib/seo-pulse` imports one write path, `beginListingChange`, which is the listing lock |
| Is the derived search model rebuildable from canonical data? | Rebuilt the whole of `product_search` and `product_search_attributes` and compared every column. On the development database: identical. On the 5,000-listing scale database: identical after S8-2, and 3,863 documents different before it |
| Does the migration chain produce the schema the development database actually has? | A database built from zero by the chain (`e2e/prepare-db.ts`) and the development database agree on all 943 columns, 284 indexes, 1,095 constraints, 79 function bodies and 44 triggers |
| Do the assumptions behind the fast opportunity report still hold? | `search_console_metrics_unique` still covers (property, day, dimension, page, query), and the test that syncs one day twice still asserts one row. `npm run perf:search-console` at 20,000 pages and 1,120,000 measurements: p50 662 ms, p95 817 ms, still reported as partial at 500 of 20,000 pages |
| Can a missing address be discovered or indexed? | Probed against the production build — section 3G.3 |
| Can a provider credential reach a browser? | No file under `.next/static` mentions any credential variable, a connection string, a private-key header or a service-account address; no `process.env.*` reference survives in the client bundles at all |
| Are the 72 parked legacy values recoverable? | Classified from the database: 71 ambiguous, 1 unusable, 0 migratable (D-109). None can be placed without inventing what a label means |
| Does the permission boundary hold on every admin surface? | All 49 admin API routes refuse a non-staff caller before reading a body, and every lib function they call checks a permission — S8-3 was the one exception. All 24 admin pages take `requireAdminPage(<permission>)`; the overview is the only one without, and it is `requireStaff` plus a `can` check per tile |

### 3G.3 R-18, answered with a production build

A missing listing, a missing shelf, and an address that matches no route at all,
all against `next start` on the production build:

| Address | Status | `robots` meta | Canonical | Structured data | Page |
| --- | --- | --- | --- | --- | --- |
| `/products/<missing>` | 200 | `noindex` | none emitted | `OnlineStore` only — no `Product`, no `Offer` | the shop's own "Product not found" |
| `/categories/<missing>` | 200 | `noindex` | none emitted | `OnlineStore` only | the shop's own "Category not found" |
| `/products/<missing>?preview=1` | 200 | `noindex` | none emitted | `OnlineStore` only | as above — the preview flag cannot conjure a listing |
| `/this-matches-no-route` | **404** | `noindex` | none emitted | `OnlineStore` only | the root not-found page |
| `/products/<real>` | 200 | indexable | its own address | `OnlineStore`, `Product`, `BreadcrumbList` | the listing |

So the soft 404 is confined to the two dynamic segments, and a missing address
cannot be *discovered*: the sitemap is built from rows that exist (39 URLs, none
of them missing), no canonical points at it, no internal link can reach it — the
link intelligence reads accepted relationships to listings a shopper can reach —
and no product structured data is emitted for it. The consequence is what D-108
said it was, now measured rather than predicted: a crawler spends a little budget
on an address that does not exist and is told `noindex`, and an uptime check
counts a 200.

**What was considered and rejected.** A `generateStaticParams` list with
`dynamicParams = false` would give a real 404 at the routing layer with no
request-time database read at all — and would also 404 every listing published
after the deploy until the next one, which is not a shop. A check in `proxy` is
still the only real fix, and it still costs a database round trip on the two
hottest routes, on a layer this repository keeps free of the database (D-108).
R-18 therefore stays open as an accepted limitation, with the exact consequence
written down and the SEO surface around it verified clean.

### 3G.4 Measured

Stage 7's figures re-measured on the same databases, plus what Stage 8 added:

| What | Stage 7 | Stage 8 | Dataset |
| --- | --- | --- | --- |
| Product save, one detail changed | 56 ms | 56.3 ms | `manifest_scale`, 5,000 listings |
| Product save, nothing changed | 16 ms | 16.6 ms | same |
| Knowledge sync, one listing | 12 ms | 12.8 ms | same |
| Option value rename (attributed) | — | 40.2 ms, 4 statements | same |
| Reconciliation report | 511 ms | 542 ms, 54 statements | same |
| SEO page audit, one listing | 6 ms | 4.1 ms | same |
| SEO Health Center | measured on 24 listings only (R-10) | 101.6 ms, 14 statements | same — R-10 answered: no cache needed |
| Product intelligence, one product | — | 22.4 ms, 27 statements (R-9 stands: one `evaluateVerification` per open claim) | same |
| Storefront search | — | 32.1 ms, 19 statements | same |
| Autocomplete | — | 60.3 ms, 11 statements | same |
| Whole-catalogue rebuild, chunks of 200 | 15.4 s over 5 passes | 14.9 s | same |
| Opportunity report, 20,000 pages | 737 ms | 662 ms p50, 817 ms p95 | `manifest_bench`, 1,120,000 measurements |
| Pruning measurements past retention | 500,000 in 2,177 ms, +106 MB of identifiers | 620,000 in 2,397 ms, live set bounded by one batch | same |

Nothing regressed. The two figures that moved — the page audit and the
opportunity report — moved downwards, and both are within the noise of a
different day on the same machine.

### 3G.5 Found and left alone

- `attribute_values` is unique on `(attribute_id, value)`, exactly, while the
  guard that refuses a duplicate option value compares case-insensitively and is
  asked before the transaction. Two renames racing can therefore leave "Walnut"
  and "walnut" on one option group. It is a data-quality wrinkle in Phase-era
  code, not a knowledge-integrity failure — both values still mirror as facts,
  and the facet shows two rows where it should show one. Recorded rather than
  fixed: the fix is a case-insensitive unique index, which needs a migration that
  first finds and merges any existing pair, and that is more regression surface
  than the defect deserves at the end of an audit.
- `deliverQueuedNotifications` is gated with `requireStaff` rather than with
  `notifications.view`, so any staff role can drain the outbox to real customers.
  Phase-era code, outside the Stages 1 to 7 surface this audit owns, and
  `notifications.view` is the permission it should ask for.
- The sitemap and `robots.txt` are built at `next build` and then revalidated
  (`cacheLife("hours")`, dropped by the catalogue cache tags). On Vercel the build
  reads the same database the deployment serves, so this is staleness bounded by
  an hour and by the next catalogue write. It is worth knowing about, because a
  build pointed at one database and served against another produces a sitemap
  describing the first — which is how it was noticed. DEPLOYMENT.md now says so.

## 3H. Stage 9 — product preparation (backend)

A diagnostic of the real Add Product workflow found what the previous eight
stages had built around rather than into: the knowledge platform had every part
of researching a product, and none of them were reached by the act of adding
one. This stage connects them. It is backend and orchestration only — the
product-entry interface is a separate piece of work, and nothing here depends on
it.

### 3H.1 What the diagnostic found, and what is true now

| Found | Now |
| --- | --- |
| Add Product collected title, category, brand, SKU — nothing a manufacturer would recognise | A save may carry an `identity` block: model name, model number, MPN, one trade identifier, the official page. Optional in every part (D-112) |
| Creating a product called `syncListingKnowledge` but never `refreshResolution`, so a new product stayed UNRESOLVED until somebody pressed a button | The mirror re-assesses resolution in the same transaction whenever a save changes the brand, the model, the generation or an identifier — and only then (D-112) |
| `requestEnrichment` was never reached from the normal product workflow | The preparation run requests it, waits for it and reports what it did (D-112) |
| "Fill with SEO Pulse" read listing columns and never saw the knowledge base | `SeoPulseInput.knowledge` carries what the knowledge base has established, through `groundedKnowledge`, under the publication rule (D-113) |
| `ProductResearchProvider` had only the unconfigured implementation | `brave` is a second, optional implementation. `none` stays the default and a supported state (D-114, A-6) |
| The rules generator produced Manifest-flavoured boilerplate for an empty listing, indistinguishable from a researched one | `knowledgeSufficiency` states the verdict, and preparation stops rather than reporting READY (D-115) |
| `provideDocument` was reported to have no route | It has had one since Stage 3: `POST /api/admin/knowledge/products/[id]/sources` with `kind: "document"`. The preparation API now also accepts one, so a run can be given a specification sheet as it starts |

### 3H.2 The preparation state model

Stored on `product_preparation_runs.stage` (migration 0043). The stages are
about the product, not about the machinery, because they are what a staff screen
will show:

```
IDENTIFYING → FINDING_SOURCES → RESEARCHING → VERIFYING
            → PREPARING_CONTENT → PREPARING_SEARCH → CHECKING_PAGE → READY

  NEEDS_REVIEW   a person has to decide something; the run waits
  BLOCKED        cannot proceed as things stand (no identity, no sources)
  FAILED         something broke; a retry may fix it
  CANCELLED      somebody stopped it
```

A stage is never reported as passed unless the work behind it finished. The
`steps` column is the record of that — one entry per step, written when the step
completes — and it is also what makes a retry skip it.

### 3H.3 The sequence, and what each step delegates to

| Step | Delegates to | Stops when |
| --- | --- | --- |
| identity | `beginListingChange` + `syncListingKnowledge`, then `reassessResolution` | AMBIGUOUS → NEEDS_REVIEW; UNRESOLVED → BLOCKED |
| sources | `sourceOutlook`: registry templates, attached pages and documents, and the research provider only when there is nothing else | nothing to read → BLOCKED, naming the provider's own state |
| enrichment | `requestEnrichment`, then waiting for that run | blocked → BLOCKED; failed → continues, marked degraded |
| verification | reading `pkb_claims` and `pkb_attribute_proposals` | a conflict, a waiting claim or an unplaced label → NEEDS_REVIEW |
| content | `knowledgeSufficiency`, then `runSeoPulse` | too little established → NEEDS_REVIEW; provider unavailable → NEEDS_REVIEW |
| search | `product_search_queue` and `search.process_queue` | a lagging index degrades, never fails |
| page | `seoReadiness` and `searchReadiness` | — |

The run generates content; it does not apply it. Applying generated wording is a
person's decision and stays where it is (D-075).

### 3H.4 What it refuses to do

- Confirm an identity. VERIFIED is only ever set by a person (D-072).
- Resolve an ambiguity, or enrich an unresolved product (D-074).
- Accept a claim, or resolve a conflict, to reach a finished run (D-076).
- Trust a domain. A discovered official-looking address is a candidate; the
  Brand Source Registry decides, and that decision asks for `knowledge.manage`.
- Write a fact from anything generated. Prose is not evidence (I-1).
- Report a product READY on copy that says nothing about the product (D-115).

### 3H.5 Tested

`tests/product-preparation.test.ts` — 20 tests, and most of them assert a
refusal: identity resolved on the save and re-assessed when it changes or is
cleared; an invalid check digit and two trade identifiers at once both refused;
an official address attached as a source and nothing more; UNRESOLVED blocked and
AMBIGUOUS sent to review with no enrichment run created; NOT_CONFIGURED reported
as itself; a staff URL and a staff document each carrying the run forward; a
proposed claim holding the run at NEEDS_REVIEW and staying a claim; insufficient
knowledge reported rather than generated over; a filled listing reaching READY
with the knowledge base unchanged by the generator; the same request key and a
live run both returning one run; a retry adding no second enrichment run, claim
or evidence row; cancellation; a failing provider blocking without corrupting;
a customer refused at every entry point; established knowledge reaching
`loadPulseInput` while an unaccepted claim does not; and nothing in a run's
reported failure that reads like a stack trace.

## 3I. Stage 10 — the staff product-entry screen

The interface Stage 9 deliberately left out (D-116). No backend was changed:
the preparation service, the orchestrator, the state model, the research
provider boundary and the SEO Pulse grounding are exactly as Stage 9 left
them. What is new is one translation module and the screens that use it.

### 3I.1 What a product-entry employee does

1. **Add Product** asks for three things: product name, brand, category. An
   optional section — "Help SeoPulse identify the exact product" — takes the
   model, the model number, the manufacturer part number, one barcode and the
   official product URL. These are the fields `productIdentitySchema` already
   accepts; nothing is stored twice. The Manifest SKU is on the same page, in
   its own panel, described as this shop's own code.
2. **Research & Prepare with SeoPulse** creates the product and starts a
   preparation run in one movement, then opens the product editor with the run
   already reporting itself. **Save without SeoPulse** creates the same product
   and stops.
3. The editor shows **one progress surface**, then only what needs a decision.
4. The employee adds price, stock and photographs, and publishes.

Nothing in that sequence requires them to know what the knowledge base, a
claim, an evidence row, an enrichment run or a research provider is.

### 3I.2 The translation layer

`lib/preparation/presentation.ts`. Pure functions, no database, unit-tested in
`tests/preparation-presentation.test.ts`.

| Backend | On screen |
| --- | --- |
| `IDENTIFYING` | Identifying product |
| `FINDING_SOURCES` | Finding trusted sources |
| `RESEARCHING` | Collecting product information |
| `VERIFYING` | Checking product information |
| `NEEDS_REVIEW` | *n* things need your attention |
| `PREPARING_CONTENT` | Preparing product content |
| `PREPARING_SEARCH` | Preparing search |
| `CHECKING_PAGE` | Checking product page |
| `READY` | Ready |
| `BLOCKED` | Preparation cannot continue yet |
| `FAILED` | Preparation stopped |
| `CANCELLED` | Preparation cancelled |

The checklist under the headline is built from the run's recorded `steps`, so
a step is shown as finished only when it finished. A `degraded` or `skipped`
step reads as done-with-limits. There is no percentage.

Failure and review codes become a heading and a set of buttons; the message and
the remedy are the backend's own words. `AUTOMATIC_SOURCE_DISCOVERY_NOT_CONFIGURED`
becomes "SeoPulse needs a product source" with *Add a source* and *Continue
manually*. `INSUFFICIENT_KNOWLEDGE` becomes "SeoPulse needs more product
information" with *Add a source*, *Add specifications* and *Check again*.
`CLAIMS_CONFLICT` and `CLAIMS_WAITING` lead to Product Intelligence, where the
decision actually belongs. A code the module has never seen still renders.

### 3I.3 Durability and polling

The product page reads the latest run on the server (`getPreparation`) and
hands it to the panel, so a refresh in the middle of a run comes back to the
same run rather than to an empty panel. The panel never starts a run on mount:
starting is always a press, and the press carries a request key, so a double
press or a retried request returns the run the server already made. Polling
runs every three seconds while the stage is one the run moves out of on its
own, pauses on a hidden tab, and stops at READY, NEEDS_REVIEW, BLOCKED, FAILED
and CANCELLED. A lost connection says so and keeps trying; it never reports the
preparation as failed.

### 3I.4 Supplying what a run is waiting for

The panel's two small forms both post to the existing
`POST /api/admin/products/:id/preparation/:runId` with `action: "continue"`:

- **identity** — model, model number, MPN, one barcode, official URL. Applied
  through the product save, so the identity is validated and re-resolved
  exactly as if it were typed into the editor.
- **sources** — official URL, one additional address, and a pasted document.
  Documents are text, and the screen says so: *Paste product specification or
  document text*, with a line explaining that attached files and photographs of
  a specification are not read. That is the real `provideDocument` contract and
  it is not dressed up.

### 3I.5 The editor's order

Product identity · Product content · Specifications · Images · Selling
information · SEO & search · Warranty & safety · Visibility & schedule.

Every panel is an existing one. The only field that changed panel is the
Manifest SKU, which left Product identity for Selling information because it is
commercial data and not manufacturer identity. Prices, stock, preorder capacity
and closing dates were not duplicated into a new form: they belong to a
variant, and the variants table stays where it is.

`Before publishing` in the sidebar now answers the publishing question once,
from `getReadiness`'s checks and `listingAudit`'s findings — the two engines
that already existed. No third readiness engine was written.

The old "Fill with SEO Pulse" panel still works and still has its route. It is
inside *Advanced tools*, folded away, along with the link to Product
Intelligence and the run's report.

### 3I.6 Permissions

Unchanged. Preparing and editing a product is `catalog.manage`, checked on the
server by `refuseNonStaff` and `requirePermission` on every route. Trust,
policy and vocabulary decisions are still `knowledge.manage` and still taken on
their own screens. `e2e/admin-boundary.spec.ts` walks `app/api/admin` and
`app/admin` from disk, so the preparation routes are covered by it without
being named.

### 3I.7 Tested

`tests/preparation-presentation.test.ts` — 16 tests over the mapping: every
stage has a sentence that is not its code; polling stops at every finished or
waiting stage; nothing is finished until recorded; exactly one step is active
and only while the run moves; a degraded step is honest; every backend code has
a heading that is not the code; an unknown code still renders with the
backend's words; the provider is never named.

`tests/product-preparation.test.ts` — two further tests for the identity
panel's save shape: model fields fold into `details` without disturbing the
weight or the dimensions, and a part number is accepted alongside the listing's
trade identifier.

`e2e/product-preparation.spec.ts` — the Add Product screen's fields and the
absence of the ones SeoPulse now writes; Research & Prepare creating the
product and one run that survives a reload; Save without SeoPulse leaving a
usable product that offers preparation later; the editor's section order, the
single publishing answer and the folded advanced tools; the primary control's
touch target and no sideways scroll on a phone.

---

## 4. Target architecture

### 4.1 Layers

```
                       ┌──────────────────────────────────────────┐
  staff (admin UI) ───▶│ lib/pkb  — Product Knowledge Base        │
                       │  identity · families · definitions ·     │
                       │  facts · identifiers · relationships ·   │
                       │  aliases · sources · evidence · claims · │
                       │  review/apply (the ONLY fact writer)     │
                       └──────┬───────────────┬───────────────┬───┘
                   projection │   read model  │   read model  │  export DTOs
                              ▼               ▼               ▼   (future API)
                  ┌───────────────┐  ┌────────────────┐  ┌──────────────────┐
                  │ Storefront    │  │ SearchPulse    │  │ lib/pkb/export   │
                  │ products,     │  │ lib/search,    │  │ rights-filtered, │
                  │ variants,     │  │ facets,        │  │ never raw tables │
                  │ offers (BDT)  │  │ product_search │  └──────────────────┘
                  └───────┬───────┘  └───────┬────────┘
                          │                  │ analytics (hashed, no PII)
                          ▼                  ▼
                  ┌─────────────────────────────────────┐
                  │ SeoPulse  lib/seo-pulse             │
                  │  intelligence: resolve → sources →  │
                  │  extract → normalize → validate →   │
                  │  PROPOSE claims (never writes facts)│
                  │  SEO: metadata suggestions, audits, │
                  │  structured data, Search Console    │
                  └─────────────────────────────────────┘
```

Writes flow one way: evidence → claims → admin decision → `lib/pkb` apply →
facts + history + audit (one transaction) → projections and cache
invalidation. SeoPulse and SearchPulse propose; they never write accepted
facts.

### 4.2 Source of truth

| Concept | Today | Target source of truth | Transition |
| --- | --- | --- | --- |
| Product (identity) | `products` row | `pkb_products` | `products.pkb_product_id`; backfill 1:1 |
| Listing (what Manifest sells) | `products` | `products` | unchanged |
| Brand | `products.brand` text | `pkb_brands` + `pkb_aliases` | `products.brand` becomes a projection |
| Manufacturer | `details.manufacturer` text | `pkb_products.manufacturer_brand_id` when resolved, else a `manufacturer` fact | backfilled as LEGACY fact |
| Category | `categories` | `categories` (navigation only) | `categories.default_family_id` suggests a family |
| Product Family | none | `pkb_families` + `pkb_family_versions` | created from categories that define specifications |
| Attribute Definition | `category_attributes`, `ProductDetails` keys in code, free `spec_table`/`measurements` labels, option names | `pkb_attribute_definitions` + `pkb_family_attributes` | legacy definitions mapped; unmatched labels queued in `pkb_unmapped_values` |
| Attribute Value | `attribute_values`, `details`, `spec_table`, `measurements`, `countryOfOrigin`, variant option values | `pkb_facts` (product or variant subject) | legacy columns projected until contract |
| Variant (identity) | `product_variants` + option values | `pkb_variants` + variant-subject facts | `product_variants.pkb_variant_id` |
| Offer | `product_variants` | `product_variants` | unchanged; never in PKB |
| Identifier | `identifier_*`, `details.manufacturerPartNumber`, `details.modelNumber` | `pkb_identifiers` | merchant SKUs stay on listing/offer |
| Relationship | none (merchandising only) | `pkb_relationships` | `product_related` stays merchandising |
| Source | none | `pkb_sources` | — |
| Evidence | none | `pkb_evidence` → `pkb_claims` | — |
| SEO metadata | `products.seo_*`, slug, canonical | same columns + `seo_field_states` + history; category SEO columns | Stage 4 |
| SEO research (keywords, SERP) | `seo_research_runs.research` | same; PROVIDER_RESTRICTED | — |
| Search knowledge | `search_synonyms`, `search_keywords`, derived `product_search` | `search_synonyms` (terms) + `pkb_aliases` (entities); `product_search` stays derived from PKB | Stage 5 |
| Search behaviour | `search_queries`, `search_clicks` | same, extended | Stage 5 |
| Search performance on Google | none | `search_console_metrics` (restricted, never exportable) | Stage 6, migration 0037 |

### 4.3 Product vs variant vs offer (D-061)

- **PKB product** — what the thing *is*, independent of whether Manifest sells
  it: brand, manufacturer, name, model, generation, family, product-level
  facts, identifiers that apply to the whole product, relationships. A
  compatibility target or predecessor can be a PKB product with no listing.
- **PKB variant** — one concrete version of that product defined by its
  variant-defining attributes (storage, colour, size…), with variant-level
  facts and its own GTIN/MPN where one exists.
- **Listing** (`products`) — Manifest's page for selling a PKB product: title,
  slug, status, photography, copy, SEO fields. One PKB product may have several
  listings later (e.g. a bundle); today it is one.
- **Offer** (`product_variants`) — price in BDT, sale window, stock or
  preorder capacity, payment mode, merchant SKU, shipping weight. Commercial,
  volatile, never in the PKB, never read from the PKB for pricing or capacity.

`product_variants.weight_grams` stays the *shipping weight* the landed-price
bookkeeping uses; the product's published item weight is a PKB fact. They are
different quantities and are documented as such rather than merged.

### 4.4 Planned PKB schema (Stage 2 finalizes columns)

Table prefix `pkb_`, module `lib/pkb/`. Every table below is part of the
reusable asset; nothing in it references a customer. Actor columns
(`created_by`, `decided_by`) reference staff users and are excluded from any
export.

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `pkb_brands` | Brand and manufacturer entities | unique `normalized_key`, unique `slug`; status `suggested`/`approved`/`retired`; never deleted while referenced |
| `pkb_families` | Product Family (a kind of product) | unique `key`; optional `parent_id` (depth-capped); status `suggested`/`approved`/`retired` |
| `pkb_family_versions` | Schema versions of a family | unique `(family_id, version)`; at most one `active` per family (partial unique index) |
| `pkb_attribute_definitions` | Global attribute vocabulary | unique immutable snake_case `key`; `data_type` ∈ text, number, quantity, range, boolean, enum, multi_enum, date, url; `unit_dimension` required iff quantity/range; default searchable/filterable/SEO/structured-data flags; `is_system` for identity attributes |
| `pkb_attribute_options` | Controlled values for enum types | unique `(definition_id, key)` |
| `pkb_family_attributes` | A definition's role in a family version | unique `(family_version_id, definition_id)`; `requirement` required/recommended/optional; `variant_defining`; flag overrides |
| `pkb_products` | Product identity | nullable `brand_id`, `family_id`; `family_assignment` assigned/unassigned/suggested; `resolution_state` VERIFIED/HIGH_CONFIDENCE/AMBIGUOUS/UNRESOLVED (default UNRESOLVED); `merged_into_id` instead of delete |
| `pkb_variants` | Variant identity | FK product; unique `(id, pkb_product_id)` for composite FKs |
| `pkb_facts` | Accepted attribute values | subject = product (+ optional variant via composite FK); typed normalized columns (`value_text`, `value_number`, `value_number_to`, `value_unit`, `value_boolean`, `value_date`, `option_id`), `value_status` value/not_applicable, `raw_value`, `raw_unit`; `verification_state`; `locked_at/by`; `origin`; `legacy_ref`; one row per single-valued slot, one per option for multi_enum (enforced in the database) |
| `pkb_fact_history` | Append-only prior values with actor, reason, claim | no updates or deletes from application code |
| `pkb_identifiers` | GTIN-8/12/13/14, ISBN, MPN, model number, ASIN, other | normalized value; GTIN check digit validated; accepted GTINs unique across the PKB (partial unique on GTIN-14 form) |
| `pkb_relationships` | accessory_for, compatible_with, successor_of, replacement_for, bundle_contains, part_of_series, requires | unique `(from, to, kind)`; `from <> to`; state, origin, evidence |
| `pkb_aliases` | Aliases for brands, products, variants, families, options | exactly one target FK (check); normalized key; `alias_kind`; status suggested/approved/rejected; origin |
| `pkb_sources` | A retrieved or entered source | `source_type`, `authority_tier`, `origin`, `usage_rights`, `retrieved_at`, `content_sha256`; normalized URL |
| `pkb_evidence` | A located excerpt in a source | FK source; `locator`; bounded `excerpt`; `extraction_method` (manual, json_ld, html_table, pdf_table, feed_field, rule, ai_assisted) |
| `pkb_claims` | A proposed value with evidence | status SUGGESTED/CONFLICT/ACCEPTED/REJECTED/SUPERSEDED; normalized columns as facts; FK evidence (required); decision actor/time/note |
| `pkb_unmapped_values` | Legacy rows that match no definition | open/mapped/dismissed; admin mapping queue |

Links added to existing tables: `products.pkb_product_id`,
`product_variants.pkb_variant_id`, `attributes.attribute_definition_id`,
`categories.default_family_id` — all nullable, all FK.

Stage 3 adds `pkb_brand_source_domains` (official product, official support,
approved secondary, blocked; tier; notes). Stage 4 added `seo_field_states`,
`seo_field_history`, `product_slug_redirects` and the category SEO columns
(migrations 0033 to 0035). Stage 6 added the Search Console tables and
`seo_opportunity_decisions` (migration 0037). The `seo_change_history` planned
here turned out to be `seo_field_history` widened rather than a second table
(D-098): it already had the columns, and two stores of one kind of record is the
mistake this programme keeps closing.

JSON is used only where the shape is small, bounded and never queried on
(definition validation rules, a run's research payload). Facts, identifiers,
relationships, aliases and evidence are relational.

### 4.5 Provenance and verification (D-063)

- **Verification states** on a slot: VERIFIED, SUGGESTED, CONFLICT,
  UNVERIFIED, MANUAL, LEGACY, LOCKED.
  - Stored on accepted facts: VERIFIED, MANUAL, UNVERIFIED, LEGACY.
  - Stored on claims: SUGGESTED, CONFLICT (plus ACCEPTED, REJECTED,
    SUPERSEDED for the decision trail).
  - LOCKED is stored as `locked_at`/`locked_by` beside the underlying state,
    because a lock protects a value without erasing whether it was verified;
    the effective state reported to the UI and API is LOCKED.
  - A slot with no fact and no claim is UNKNOWN. UNKNOWN is never stored as
    false, zero or not applicable; NOT_APPLICABLE is an explicit fact.
- **Origin classification** on every source, copied to facts for filtering:
  MANIFEST_CREATED, MANUAL_ADMIN, OFFICIAL_MANUFACTURER,
  APPROVED_EXTERNAL_SOURCE, SUPPLIER_PROVIDED, PROVIDER_RESTRICTED,
  CUSTOMER_DERIVED, UNKNOWN_LEGACY.
- **Usage rights** on sources: internal_only, display, exportable, unknown.
  Export eligibility is one tested function of origin, rights and state.
- **Authority tiers** (Stage 3): 1 official manufacturer pages, specifications,
  documentation, support, feeds; 2 authorized distributor, trusted retailer,
  reliable product database; 3 other approved public sources. Unlisted domains
  carry no tier and cannot verify anything on their own.
- **Verification is evidence-policy driven** (revised A-4, D-063 amended).
  Official manufacturer evidence is the preferred, highest-authority path, but
  not the only one. A verification policy decides, per family or attribute
  where needed, which evidence may support VERIFIED: authoritative manufacturer
  documentation, approved manufacturer or supplier feeds, official
  documentation an admin provides, and other sources an admin has explicitly
  marked trusted. Every fact keeps its exact source, source type, acquisition
  method and authority, so the basis of each VERIFIED value can be shown and
  re-evaluated. Evidence that no policy accepts is never silently promoted: it
  stays SUGGESTED, or UNVERIFIED once accepted. Typed by an admin → MANUAL.
  Backfilled → LEGACY with UNKNOWN_LEGACY origin. Nothing is promoted by a
  migration or by AI.
- **Database guard** (Stage 2): a fact can be VERIFIED only with an accepted
  claim (which requires evidence) and a recorded decision basis — the deciding
  admin or the key of the verification policy that authorized it. The policy
  engine itself is built in Stage 3.
- **AI** may locate an excerpt in a real source (`extraction_method =
  ai_assisted`) or write SEO language; it is never a source, never evidence on
  its own, and never decides a fact.

### 4.6 Product Families (D-064)

Data-driven. A family version lists attribute definitions with a requirement
level and a variant-defining flag; families may inherit from a parent.
Completeness is computed against the family's active version: verified,
suggested, conflict, missing required, missing recommended. A product with no
suitable family stays `unassigned` — never forced into a near miss — and may
carry a *suggested* family that needs `knowledge.manage` approval before it
becomes reusable. Schema changes create a new version; facts are never deleted
when a definition leaves a family (they become product-only facts).

Adding a category, family or attribute is a data operation. The only code
change a new kind of product can need is a new *unit dimension*.

### 4.7 Normalization (D-065)

- Units live in a code registry (`lib/pkb/units.ts`): dimension, canonical
  unit, aliases, conversion. Canonical units: mass g, length mm, data storage
  byte (decimal GB = 10⁹ bytes; GiB separate), frequency Hz, power W, energy
  Wh, electric charge mAh, voltage V, current A, duration s, volume mL,
  temperature °C, pixel count px. "256GB", "256 GB" and "256 gigabytes" all
  become 256 000 000 000 byte; "1000 g" and "1 kg" both become 1000 g.
- Parsing is deterministic; an unparseable value is kept raw with no
  normalized value and flagged, never guessed.
- Enum values normalize through option keys and option aliases ("Space Grey"
  → `space_gray`).
- Identifiers normalize by type (GTIN digits and check digit; MPN case and
  punctuation folded for matching, raw kept for display).
- Raw source text and unit are always retained.
- Search normalization (`lib/search/normalize.ts`) reuses the same unit and
  model-number rules in Stage 5, so a query and a fact normalize identically.

### 4.8 SeoPulse boundaries (D-066)

SeoPulse owns: product resolution, the brand source registry, source retrieval
(behind SSRF guards), extraction, normalization and validation of *claims*,
conflict detection, completeness, attribute discovery proposals, SEO metadata
suggestions, technical SEO audits, structured-data generation and audit, and
Search Console intelligence. It writes only: sources, evidence, claims,
research runs, SEO suggestions and audit results. Accepting a claim, locking a
value, approving a family or an attribute definition goes through `lib/pkb`
review services with a server-side permission check, in one transaction with
history and audit. Research and retrieval run as jobs, never in a storefront
request and not synchronously in an admin request.

**Source acquisition is provider-agnostic** (revised A-6). Sources can arrive
through any of: known official domains in the Brand Source Registry, URLs staff
provide, documents or data staff provide, approved manufacturer or supplier
feeds, lawful public or free mechanisms where implemented, and optional
`ProductResearchProvider` implementations (free or paid) added later. Every
source records how it was acquired (`acquisition_method`). When automatic
discovery is not available for a product, the pipeline reports NOT_CONFIGURED
or UNAVAILABLE and carries on with what staff supply; it never invents a source,
a URL or a value.

### 4.9 SearchPulse boundaries (D-067)

SearchPulse (the name for `lib/search` + `lib/catalog/{discovery,facets,
filter-params}` + search analytics) reads the PKB only through read models:
the trigger-built `product_search` row (rebuilt from accepted, displayable,
searchable facts) and a typed facet read model built from `pkb_facts`. It
writes search analytics and *suggested* aliases; approving an alias is a
`search.manage` decision in `lib/pkb`. No customer identifier enters the PKB.
The existing module names are kept rather than renamed.

### 4.10 Future API boundary (D-068)

No API is built. The boundary is prepared: `lib/pkb/export.ts` will define
explicit DTOs that include only export-eligible facts (origin, usage rights and
state checked by one function), public identifiers, and no actor, internal
note, cost, offer or provider-restricted data. Nothing outside `lib/` reads
`pkb_*` tables directly, matching the existing data-access rule.

### 4.11 Permissions

- `catalog.manage` (existing): product-level fact review, accept, reject,
  edit, lock, add source, resolve identity.
- `knowledge.manage` (new, Stage 2): global vocabulary — families and their
  versions, attribute definitions and options, brand entities and merges, the
  brand source registry. Granted to `super_admin`, `staff_admin`,
  `product_manager`.
- `search.manage` (existing): alias and synonym approval.
- Search Console access needs `catalog.manage` (Stage 6, D-096). This plan had
  said `analytics.view`; the people who act on it are the catalogue staff —
  `product_manager` holds `catalog.manage` and not `analytics.view` — and what
  is shown is the shop's own pages rather than customer behaviour.

### 4.12 Migration strategy (D-069) — expand, backfill, cut over, contract

1. **Expand (Stage 2).** Migration `0031_product_knowledge_base.sql` (and
   following) creates `pkb_*` tables and the nullable link columns. No existing
   column changes meaning. Drizzle declarations in `db/schema/pkb.ts`.
2. **Backfill (Stage 2).** An idempotent TypeScript command and job
   (`npm run pkb:backfill`, `pkb.backfill`) — TypeScript, not SQL, so it uses
   the same normalization code as live writes. Per listing: create brand (exact
   normalized match only; near-duplicates are reported, never merged), PKB
   product, PKB variants, identifiers, and LEGACY facts with
   `origin = UNKNOWN_LEGACY` and `legacy_ref` (e.g.
   `products.details.itemWeight`) so re-runs update rather than duplicate.
   Categories that define specifications become approved families (their
   definitions were created by staff); products are assigned the nearest
   ancestor's family or left unassigned. Rows that match no definition go to
   `pkb_unmapped_values`. The command prints a reconciliation report
   (listings, facts per legacy column, unmapped rows, brand collisions) and
   refuses to report success if any listing lacks a PKB product.
3. **Cut over writes (Stage 2–3).** The Specifications and Basics panels write
   facts through `lib/pkb`, which rewrites the legacy columns as projections in
   the same transaction, so the product page, search trigger, facets and
   SeoPulse keep working unchanged. After a field is cut over, only
   `lib/pkb/projection.ts` may write its legacy column. SeoPulse fill stops
   writing `spec_table`/`measurements` (F1).
4. **Move readers (Stages 4–5).** Structured data, product page tabs, search
   trigger and facets read PKB read models.
5. **Contract (Stage 7).** Once a legacy column has no reader (checked by a
   test that greps for it), it is dropped in a migration; `category_attributes`
   likewise. Never before the reconciliation report is clean on the target
   database.

Migrations follow the repository convention: new numbered files, never edited
after being applied, idempotent statements, applied through `db/migrator.ts`,
verified on PGlite and real PostgreSQL.

---

## 5. Invariants

| # | Invariant | Enforced by | Status after Stage 2 |
| --- | --- | --- | --- |
| I-1 | AI output is never evidence. A claim requires an evidence row from a non-AI source. | `pkb_claims.evidence_id` not null; no AI source type; AI-assisted evidence must quote | ENFORCED (database), tested |
| I-2 | Nothing becomes VERIFIED without an accepted, evidenced claim and a decision under an evidence policy (A-4). | `pkb_facts_verified_check`; policy engine Stage 3 | ENFORCED at database level; policy Stage 3 |
| I-3 | Backfill and migration never produce VERIFIED; legacy data is LEGACY / UNKNOWN_LEGACY. | mirror attribution; `pkb_facts_legacy_check` | ENFORCED, tested at PGlite, dev and scale |
| I-4 | MANUAL and locked values are never overwritten automatically; disagreement becomes CONFLICT. | mirror (refuse/revert), claims (CONFLICT) | ENFORCED, tested |
| I-5 | UNKNOWN ≠ false ≠ zero ≠ not applicable. Absence of a row is unknown. | `value_status`, shape checks | ENFORCED, tested |
| I-6 | Raw source value and unit are kept beside the normalized value. | shape check requires raw text | ENFORCED |
| I-7 | Analysis never mutates accepted facts; only `lib/pkb` does, in one transaction with history and audit. | module boundary | Holds today (SeoPulse does not import `lib/pkb`); an import-boundary test is planned for Stage 3 |
| I-8 | Offer data (price, stock, capacity) is never stored in or read from the PKB. | schema has no such columns; triggers ignore those columns | HOLDS |
| I-9 | No customer PII in `pkb_*`; customer-derived signals only aggregated and thresholded. | schema; actor columns reference staff | HOLDS |
| I-10 | Provider-restricted data is never exportable. | `exportEligibility` | Rule built and tested; no export exists |
| I-11 | Shoppers see only accepted facts; structured data identifiers only VERIFIED or MANUAL. | read models | Structured data since Stage 4; search and facets since Stage 5 (`product_search.terms`, `product_search_attributes`). The product page's Specification and Measurements tabs still read the legacy columns, which the projection keeps in step (D-070) — they move when those columns are contracted in Stage 7 |
| I-12 | After cut-over, a legacy column is written only by the projection. | code search test | Stage 7. Stage 5 deliberately kept the legacy option and specification paths as *readers* beside the knowledge ones (D-095), so the coverage can be measured before anything is removed |
| I-13 | New categories, families and attributes are data operations. | design | HOLDS (only a new unit dimension needs code) |
| I-14 | Every PKB mutation checks permission in `lib/`. | `requirePermission` in every service | HOLDS, tested for families, sources, claims, aliases, facts |
| I-15 | No outbound fetch without SSRF guard, timeout, size cap and robots check. | `lib/pkb/net/` | ENFORCED since Stage 3, proved by `tests/pkb-net.test.ts` (38) |
| I-16 | Existing checkout, capacity, pricing and publish invariants are untouched. | existing suites | HOLDS — full unit project 1,302 passed after Stage 5 |
| I-17 | SearchPulse proposes; it never writes reusable knowledge. An alias becomes search vocabulary only through a suggestion and then an approval. | `lib/pkb/aliases.ts` permission checks; the index reads only `status = 'approved'` | ENFORCED, tested (a suggested alias finds nothing; a rejected one stops finding) |
| I-18 | External performance data is never product truth. A Search Console query cannot become a fact, an attribute, an alias or SEO copy without a person suggesting it and a second decision approving it. | `lib/search-console/learning.ts` returns recommendations only; no module under `lib/search-console` imports a `lib/pkb` write path | ENFORCED since Stage 6, tested (generating recommendations creates no alias and no fact) |
| I-19 | A measurement is stored once. Re-reading a day updates its rows rather than adding any, so a retried or overlapping sync cannot double-count. | the unique key on `search_console_metrics` and the upsert in `lib/search-console/sync.ts` | ENFORCED (database), tested (a second sync writes nothing; a revised day updates in place) |
| I-20 | The shop never claims a change caused a change in performance. | `compareAroundChange` wording and its `causation` field | ENFORCED, tested against five causal phrasings |
| I-21 | A derived read model is rebuildable to the same bytes from the canonical data. Refreshing one listing and refreshing it in a batch produce the same row. | `refresh_product_search` aggregates in a declared order (migration 0042); `tests/search-document-order.test.ts` fails on any aggregate in it that can return rows arbitrarily | ENFORCED since Stage 8, tested, and verified by rebuilding the whole model on both the development and the 5,000-listing databases |
| I-23 | A product's stored resolution state is never older than its identity. Any save that changes the brand, the model, the generation or a trade identifier re-assesses it in the same transaction. | `syncListingKnowledge` (`identityTouched`) | ENFORCED since Stage 9, tested (created, changed and cleared identity) |
| I-24 | Orchestration decides nothing a person decides. A preparation run may continue only where the existing rules already permit it; it never confirms an identity, accepts a claim, approves a domain or applies generated wording. | `lib/preparation/runner.ts` delegates every decision to `lib/pkb`, which asks for permission itself | ENFORCED since Stage 9, tested (ambiguous identity, waiting claim, conflicting claim) |
| I-22 | Where a write depends on a row's current state, the lock comes before the check, and the check is repeated in the write's own predicate. | `updateProduct`, `applySeoPulse`, `decideAlias`, `reassessResolution`, `loadClaimsForDecision` | ENFORCED, and each proved by a real-PostgreSQL race that fails without the fix (D-110) |

---

## 6. Tests and checks

### Stage 1 (2026-09-17, commit `1e2e9d3`, no code changed)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| Targeted Vitest: `seo-pulse`, `seo`, `search-engine`, `search-index`, `search`, `facets`, `product-details`, `catalog`, `schema`, `migrations` | PASS — 10 files, 192 tests, 22.5 s |
| Development database profile | done (section 3.1) |

Not run in Stage 1, by design: full unit suite, end-to-end suite, production
build (no application code changed).

### Stage 2 (2026-09-17)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `tests/pkb-normalization.test.ts` | PASS — 23 |
| `tests/pkb-backfill.test.ts` (PGlite) | PASS — 11 |
| `tests/pkb-sync.test.ts` (PGlite) | PASS — 11 |
| `tests/pkb-model.test.ts` (PGlite) | PASS — 17 |
| `tests/pkb-sync-concurrency.test.ts` (real PostgreSQL) | PASS — 1 (8 listings × 4 rounds of staff saves, bypassing writes and 4 workers) |
| `tests/migrations.test.ts` | PASS — 5 |
| Whole Vitest `unit` project (PGlite) | PASS — 82 files, 1,159 tests |
| Backfill + reconciliation on `manifest_scale` and dev `preorder` | clean (section 3A.3) |
| Real admin API save on the dev site | verified (section 3A.3) |

Not run in Stage 2: the end-to-end suite and a production build (no pages or
routes changed; the storefront reads the same columns), and the real-PostgreSQL
concurrency suites other than the new one.

### Stage 4 (2026-09-18)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `tests/seo-engine.test.ts` | PASS — 14 |
| `tests/seo-audit.test.ts` (new) | PASS — 11 |
| `tests/seo-pulse.test.ts`, `seo`, `catalog`, `migrations`, `pkb-write-paths` | PASS — 98 across six files with `seo-engine` |
| Migrations 0033, 0034, 0035 on the dev database | applied |
| The four audit modules run against the dev database | real counts returned (section 3C.2) |
| `/admin/seo-health`, the product editor's Page audit, a shelf save round trip | exercised on the running dev site |

Not run in Stage 4: the end-to-end suite, a production build, and the
real-PostgreSQL suites. `e2e/seo.spec.ts` was updated for ProductGroup and
image entries earlier in the stage but has not been run; it belongs to the full
verification in Stage 8.

### Stage 5 (2026-09-18)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `tests/search-knowledge.test.ts` (new) | PASS — 54 |
| `search-engine`, `search`, `search-index`, `search-analytics`, `facets`, `discovery`, `filter-chips`, `catalog`, `migrations`, `schema`, `checkout`, `product-details` | PASS — 214 across twelve files |
| Whole Vitest `unit` project (PGlite) | PASS — 88 files, 1,302 tests, 226 s |
| Migration 0036 on dev `preorder` and on `manifest_scale` | applied |
| `npm run pkb:backfill -- --report` on dev, after the migration | clean |
| Search, facets and the index rebuild timed on both databases | section 3D.5 |
| The storefront and `/admin/search` exercised on the running dev site | done |

Not run in Stage 5, by design: the end-to-end suite, a production build, and
the real-PostgreSQL concurrency suites. `e2e/search.spec.ts` and
`e2e/filters.spec.ts` exercise the paths this stage changed and belong to the
full verification in Stage 8.

### Stage 6 (2026-09-18)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `tests/search-console.test.ts` (new) | PASS — 47 |
| `seo-engine`, `seo-audit`, `seo-pulse`, `catalog`, `migrations`, `jobs`, `schema`, `pkb-write-paths` | PASS — 161 across eight files with the new one |
| `search-knowledge`, `search-engine`, `seo`, `discovery`, `facets`, `env`, `observability` | PASS — 135 across seven files |
| Migration 0037 on dev `preorder` | applied |
| `npm run pkb:backfill -- --report` after the migration | clean |
| `/admin/seo-performance`, the listing editor's box, both API routes, and a shelf save | exercised on the running dev site (section 3E.4) |
| The connected screen, the opportunity engine and a failing sync | exercised against a dummy local property with fixture measurements, then removed (section 3E.4) |
| Google's real responses | **UNVERIFIED — external integration unavailable.** No Search Console credentials exist. The request and response shapes follow the published API and are parsed defensively; a mismatch becomes a reported provider failure on the sync, never a stored number |

Not run in Stage 6, by design: the end-to-end suite, a production build, the
whole unit project, and the real-PostgreSQL concurrency suites. Nothing in this
stage changes a storefront read path.

### Stage 7 (2026-09-24)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| Whole Vitest unit project (PGlite) | PASS — 106 files, 1,471 tests, 8 skipped, 251 s |
| The real-PostgreSQL concurrency suites (product save, SEO apply, search rebuild, jobs, rate limit) | PASS, and each confirmed to fail with its fix removed |
| `npm run build` | PASS — the first production build in this repo (it failed first; see 3F.7) |
| `npm run test:e2e:prod` — the whole suite against that build | PASS — 490 tests, 6 skipped by design (viewport-specific), 4.4 m |
| The same suite against `next dev` | NOT A RELIABLE SIGNAL — Turbopack aborted the dev server part-way through ("An unexpected Turbopack error occurred"), failing every test after it. Nothing in the panic points at this repo's code, and the same suite passes against the production build |
| Migrations 0038 to 0041 on dev `preorder` | applied |
| `npm run perf:search-console` on `manifest_bench` (1,120,000 measurements, 20,000 pages) | measured — section 3F.3 |
| `/admin/jobs`, the knowledge screen's legacy coverage report, `/admin/seo-performance` | exercised on the running dev site |

Two things the end-to-end suite found, both of them real:

- A second-factor ceiling nothing could raise. Ten attempts per address per
  fifteen minutes is right for the shop and wrong for a suite that signs a dozen
  accounts in from one address; the suite was being refused with "too many
  attempts" and reading it as a broken sign-in. Both ceilings are configurable
  now (`TWO_FACTOR_RATE_LIMIT_PER_ACCOUNT`, `TWO_FACTOR_RATE_LIMIT_PER_IP`), the
  per-account one — the one that stops guessing — stays at ten, and only the
  address ceiling is raised for the test server. The failure was reproducible
  under the full suite and absent when the spec ran alone, which is what a shared
  ceiling looks like.
- A missing address answers 200 with noindex rather than 404 (F17, R-18, D-108).


### Stage 8 (2026-09-24)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| Whole Vitest unit project (PGlite) | PASS |
| The real-PostgreSQL concurrency suites, now seven of them | PASS, and the new one confirmed to fail with its fix removed |
| Both projects together (`npm test`) | PASS — 109 files, 1,484 passed, 8 skipped, 261 s. Stage 7 was 106 and 1,471; the thirteen new cases are S8-2 (2), S8-3 (1), S8-4 (2), S8-5 (4) and the parked-value classification (4) |
| `npm run build` | PASS |
| Playwright against that build (`E2E_PRODUCTION=1`) | PASS — 490 passed, 6 skipped by design, 0 failed, 4.5 m. Identical to Stage 7 |
| Migration 0042 on `preorder`, `manifest_scale` and `manifest_bench` | applied |
| `npm run pkb:backfill -- --report` on dev | CLEAN — 25 listings and 30 offers all linked, nothing queued, no VERIFIED value without a claim, no projection mismatch, `ok: true` |
| Development schema versus a database built from zero by the chain | IDENTICAL — 943 columns, 284 indexes, 1,095 constraints, 79 function bodies, 44 triggers |
| `product_search` and `product_search_attributes` rebuilt from canonical data and compared | IDENTICAL on `preorder` (25 listings) and on `manifest_scale` (5,000) — and 3,863 documents different before migration 0042 |
| `npm run perf:search-console` on `manifest_bench` | p50 662 ms, p95 817 ms at 20,000 pages and 1,120,000 measurements (Stage 7: 737 ms) |
| `scripts/perf/knowledge-bench.ts` on `manifest_scale` | measured — section 3G.4, nothing regressed |
| A missing listing, a missing shelf and an unmatched route against `next start` | measured — section 3G.3 |
| The built client bundles searched for credentials | CLEAN — no credential variable, connection string, private key or service-account address, and no `process.env` reference at all |
| Google Search Console itself | UNVERIFIED — external integration unavailable (R-15). Reviewed against the published contract; every failure mode exercised with a fixture at the provider boundary |

What the audit's own checks found, which no suite would have:

- The derived search model could not be rebuilt to the same bytes (S8-2). Only
  rebuilding it and comparing shows that; no test asserted it, and now two do.
- The development database was missing an index because an applied migration had
  been edited (S8-1). The ledger caught it the moment anything tried to migrate.
- Two write paths were guarded outside their locks (S8-3, S8-4) — found by looking
  for the shape Stage 7 had already fixed twice, rather than by reading each file.
- A scheduled job's memory was decided by how much there was to delete (S8-5).
  Measuring it took one script; reasoning about it had missed it for six stages.

---

## 7. Unresolved issues and assumptions

Assumptions taken so work is not blocked (each cheap to reverse; the owner can
overturn any of them):

- **A-1** LEGACY facts remain visible on the storefront, as they are today.
  Hiding them would empty most specification tables.
- **A-2** Brand near-duplicates are never merged automatically; they appear in
  an admin queue.
- **A-3** Categories that already define specifications become approved
  families on backfill, because staff authored those definitions.
- **A-4** *(revised by the owner at the start of Stage 2)* Official
  manufacturer evidence is the preferred, highest-authority verification path,
  but not the only one. VERIFIED is decided by evidence policy: authoritative
  manufacturer documentation, approved manufacturer or supplier feeds, official
  documentation provided by an admin, and other explicitly trusted sources may
  support it depending on the product and the evidence available. Exact
  provenance and source authority are always kept, and lower-quality evidence
  is never silently promoted to VERIFIED.
- **A-5** The one-click "Fill with SeoPulse" (D-040) becomes a proposal and
  review flow in Stage 3. This is a visible change for staff.
- **A-6** *(revised by the owner at the start of Stage 2)* Automatic source
  discovery is not assumed to need a paid search service. Acquisition is
  provider-agnostic: Brand Source Registry domains, staff-provided URLs,
  staff-provided documents or data, approved supplier and manufacturer feeds,
  lawful public or free mechanisms where implemented, and optional
  `ProductResearchProvider` implementations later. When automatic discovery is
  unavailable the system reports NOT_CONFIGURED or UNAVAILABLE instead of
  inventing sources or data.
- **A-7** *(Stage 2; **APPROVED** by the owner at the start of Stage 3)*
  Migrated and copied listing facts stay unchecked (LEGACY, or UNVERIFIED for a
  duplicated listing) unless they independently satisfy the verification policy
  with appropriate evidence and decision history. Migration never makes a value
  VERIFIED.
- **A-8** *(Stage 2; **APPROVED WITH CONTROLLED EXPANSION** at the start of
  Stage 3)* Exact label, key or approved-alias matching stays the only
  automatic behaviour. Stage 3 adds a reviewed mapping workflow for unmatched
  labels: when staff approve that a label maps to a canonical attribute (or is
  not an attribute), the decision is stored as reusable knowledge, scoped to a
  family where it needs to be, and future rows with that label map
  deterministically. No fuzzy matching. The 69 unmatched dev rows are reviewed
  through the workflow, never repaired in the database by hand.
- **A-9** *(Stage 2; **MODIFIED** by the owner at the start of Stage 3)* A
  brand existing in the Manifest catalogue and a brand's sources being trusted
  are separate. Catalogue brands are valid without re-approval (status
  `active`). Trust assertions — official product and documentation domains,
  source preferences, manufacturer identity mappings — start SUGGESTED and
  count for nothing until an approved decision or evidence supports them.
  Brand existence ≠ trusted source verification.
- **R-6 decision** *(owner, start of Stage 3)* Identifier history is built in
  Stage 3: every change to a GTIN/UPC/EAN/ISBN/MPN/model number or other
  identifier keeps the previous value, new value, actor or source, time and
  reason, append-only. Invalid identifiers keep the original text, are marked
  invalid, and a check digit is never "corrected" by guessing.
- **Network safety** *(owner, start of Stage 3)* SSRF and network protections
  ship with the first retrieval code: localhost, private and internal ranges,
  cloud metadata endpoints, unsafe redirects, DNS rebinding, timeouts,
  response-size limits, protocol restrictions, safe parsing.

Open risks:

- **R-1** Production data volume and shape are unknown. Measured on
  `manifest_scale` (5,000 listings, 176 s, clean); the production run should
  still be done with `npm run pkb:backfill` and its report checked.
- **R-2** A changed product save costs ≈28 ms more (8 → 36 ms median); a no-op
  sync ≈27 ms, mostly reloading the vocabulary per listing. Optimise in Stage 7
  (vocabulary cache keyed by a change signature).
- **R-3** (CLOSED as a tracking item, Stage 8) Every numbered finding is
  accounted for. F1 to F4 closed in Stage 3 (D-075); F5, F6, F7, F9, F13, F15 and
  F16 in Stage 4; F10, F11 and F12 in Stage 5 (D-090); F8 in Stage 7. Two remain
  open **by decision, not by omission**: F14's remainder — `search_keywords` is
  retained deliberately and offered as alias suggestions (D-105) — and F17, the
  soft 404 on a missing address (D-108, verified in 3G.3 and accepted as R-18).
  Stage 8 added S8-1 to S8-5, all fixed, and two items it deliberately left alone
  (3G.5).
- **R-4** CLOSED. Outbound retrieval exists and is guarded by
  `lib/pkb/net/safe-fetch.ts` and `robots.ts`, proved by `tests/pkb-net.test.ts`
  (38 tests) and documented in SECURITY.md.
- **R-5** CLOSED for regressions: `tests/pkb-write-paths.test.ts` reads
  `lib/catalog` and fails when a file writes `products`, `product_variants` or
  the variant option values without locking or syncing the mirror. The option
  vocabulary and category specifications stay trigger-covered by design.
- **R-6** CLOSED. `pkb_identifier_history` records created, updated, cleared,
  locked and unlocked with before, after, actor or source, time and reason;
  append-only, and backfilled for existing identifiers.
- **R-8** (new) Renaming an option value (`lib/catalog/attributes.ts`) reaches
  the mirror through a trigger rather than in-transaction, so the change arrives
  unattributed. For a slot whose knowledge value is decided, the sync records it
  as an unattributed change rather than applying it. Worth a decision in Stage 7:
  either thread attribution through the option-vocabulary writes, or treat
  option renames as a legacy-attributed change.
- **R-9** (open, re-measured in Stage 8) `getProductIntelligence` runs
  `evaluateVerification` once per open claim. Measured on the scale database it is
  22.4 ms in 27 statements for a product with a handful of open claims, which is
  why it has not been batched: the cost is per open claim, and a product with
  dozens of them is a product somebody needs to review rather than a page that
  needs to be faster. Batch it if a run ever proposes dozens.
- **R-10** (CLOSED, Stage 8) The SEO Health Center's five catalogue-wide reads
  were only ever measured on the 24-listing development database. On
  `manifest_scale` (5,000 listings) the screen is **101.6 ms in 14 statements**.
  No cache and no further index work: the screen is an admin page loaded
  deliberately, and a tenth of a second at five thousand listings is not a
  problem worth new machinery. Migration 0038 had already replaced the index the
  description checks could not use.
- **R-11** (new) Photograph dimensions and weight come from the media registry, so
  a file that did not go through the media registry has no recorded size. All 26
  dev photographs are in that state, which is reported as unknown rather than
  guessed at, but it means the too-small and heavy counts understate reality
  until uploads have been through the registry.
- **R-12** (new, Stage 5) `refresh_product_search` now reads eight more tables,
  and a *whole-catalogue* rebuild is much more expensive than before — see
  section 3D.5 for the measured figures. It only matters for the "Rebuild search
  index" button, which already chunks by 200, and for the final statement of
  migration 0036. Normal running is unaffected, because a listing is rebuilt one
  at a time by the deferred trigger. Worth profiling in Stage 7 before the
  catalogue is much larger.
- **R-13** (CLOSED, Stage 7, confirmed in Stage 8) Accepting a claim or
  approving an alias queues a listing for reindexing through row-level triggers on
  `pkb_facts` and `pkb_identifiers`. Stage 7 made a bulk import declare itself
  (D-102) so the queue is drained by the worker rather than at every commit, and
  the 5,000-listing backfill came down from 305 s to 181 s with the listings
  queued. Stage 8 re-measured the worker's side of it: a whole-catalogue rebuild
  in chunks of 200 is 14.9 s, and after migration 0042 it rewrites only rows that
  actually changed.
- **R-14** (new, Stage 5) Purchase attribution depends on a first-party cookie
  set by the click beacon. A shopper who blocks it, or who opens a result in a
  way that does not fire the beacon, is simply not attributed — the count
  understates rather than invents, which is the right direction, but the
  conversion figure is a floor and the report says so.
- **R-7** The dev seed's UPC `0812345678901` fails its check digit; it is stored
  as invalid and parked. Seed data only.
- **R-15** (OPEN, and the only externally unverified integration)
  `GoogleSearchConsoleProvider` has never spoken to Google. Stage 8 reviewed it
  against the published contract as far as is possible offline: the endpoint
  (`searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query`),
  the service-account JWT grant and its `webmasters.readonly` scope, the request
  body (`startDate`, `endDate`, `dimensions`, `rowLimit` — capped at Google's
  25,000 — `startRow`, `type: "web"`, `dataState: "final"`), the row-offset
  pagination, and a response parsed by schema so a shape it does not recognise
  becomes a reported provider failure rather than a stored number. Every failure
  mode is exercised with a fixture at the provider boundary. None of that is a
  substitute for one real call: credentials or a staging property close this, and
  nothing else does.
- **R-16** (CLOSED, Stage 7) `opportunityReport` reads up to 500 pages and 500
  page-and-query rows per window and does the banding in TypeScript. Stage 6
  predicted that at a large property the limits would truncate rather than slow.
  Measured at 20,000 pages and 1,120,000 stored measurements
  (`scripts/perf/search-console-bench.ts`), the truncation prediction was right
  and the timing prediction was wrong: the report took **4,867 ms**, of which
  4,422 ms was two calls to `pagePerformance`. Neither cost was the scan.
  `count(distinct measured_on)` per page cannot be aggregated in parallel and
  sorts each group, and multiplying `numeric` positions per row cost more than
  reading them. Counting rows (safe: a page has at most one row per day, which
  `search_console_metrics_unique` enforces and a test now asserts) and
  multiplying in `float8` brings the same report to **737 ms** with identical
  output. The limits stay where they are, and the screen already says the list is
  partial — it reported 500 of 20,000 pages throughout. The product editor's box
  deliberately does *not* run this report — it makes three scoped reads — so the
  listing editor does not get slower as the catalogue grows.
- **R-17** (open, narrowed twice) The sync stores whatever Search Console
  reports, including pages this shop no longer has. That is deliberate — it is how
  a mis-sent address becomes visible — but it means the table's size is driven by
  Google rather than by the catalogue. Stage 7 put the row count, the stored date
  range, the size on disk and what the next prune will remove on the screen.
  Stage 8 made the prune itself bounded (D-111), which is what the unbounded
  growth actually threatened. What remains is the growth itself: an operator has
  to notice it, because nothing alerts on it.

- **R-18** (new, Stage 7) An address with no listing or shelf behind it answers
  200 with `<meta name="robots" content="noindex">` instead of 404 (finding F17).
  This is Cache Components behaving as documented: every dynamic route streams a
  static shell, so the response has committed to 200 before `notFound()` fires,
  and Next injects the noindex tag rather than changing a status it can no longer
  change. The shop's own not-found page still renders, and a noindex page is kept
  out of search results, so the visible consequences are a crawler spending a
  little budget on addresses that do not exist and a monitoring tool that counts
  200s. The fix is to check existence before the response streams, which means in
  `proxy` — a database read on the hottest storefront routes, on a layer this
  repo deliberately keeps free of the database and of application imports
  (D-108). **Stage 8 verified it against a production build and accepted it**: the
  soft 404 is confined to the two dynamic segments, an unmatched route answers a
  real 404, and a missing address emits no canonical, no product structured data,
  no sitemap entry and no internal link, so it cannot be discovered (3G.3). A
  `generateStaticParams` list was considered and rejected — it would 404 every
  listing published after a deploy. The remaining consequence is a little crawl
  budget and a 200 in an uptime check.

---

## 8. After the programme

The eight stages are complete. Nothing in this repository has been deployed,
pushed or published, and Stage 8 changed that in no way: it audited, fixed five
defects, measured, and wrote down what remains.

**What a reader of this file needs to know first.** Sections 3G.1 to 3G.5 are
Stage 8's findings and its measurements; sections 5 and 6 are the invariants and
every check that has been run; section 7 is the open risks, each with why it is
still open. D-109 to D-111 are Stage 8's decisions. The verification the
programme ends on is the five commands in that order:
`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run test:e2e:prod` — all five passing as of the last Stage 8 commit, so a
failure is a regression and belongs before any new work.

**No technical launch blocker remains.** That is not the same as ready to trade:
what is left is configuration, one external integration nobody can verify without
credentials, and the operational routine around a real shop.

Before a first production deployment, in this order:

1. **Configure.** DEPLOYMENT.md lists every variable. The ones without a working
   default are the database, the session secret, the payment provider, the media
   provider and the scheduler secret. Search Console, DataForSEO and Claude are
   all optional, and every screen that uses one says so when it is absent.
2. **Migrate and import.** `vercel-build` applies the migrations; then run
   `npm run pkb:backfill` against the direct address and read its reconciliation
   report. It exits non-zero unless every listing and offer is linked and every
   projection agrees. This is R-1: the production catalogue's size and shape are
   still unknown, and 5,000 listings is the largest this has been run against.
3. **Connect Search Console, or decide not to.** R-15 is the one thing local work
   cannot close: the Google provider has never spoken to Google. Connecting it is
   two variables and adding the service account to the property; the first sync
   either works or reports a provider failure, which is the intended failure mode.
4. **Watch the first prune and the first rebuild.** Both are bounded now (D-102,
   D-111) and both report what they did on `/admin/jobs`. The Search Console
   table's size is driven by Google rather than by the catalogue (R-17), and
   nothing alerts on it.
5. **Work the knowledge queue.** The parked values are classified on the
   knowledge screen (D-109) and the labels waiting for a decision are on the same
   page. Until somebody works through them, the legacy tables stay where they are
   — which is correct, and is what the coverage report is for (D-103).

The work most worth doing next, in the order the evidence supports:

1. The labels and parked values, because every legacy contraction waits on them
   and nothing else can be done about it in code.
2. Whatever the first real Search Console connection teaches (R-15).
3. The two items Stage 8 left alone in 3G.5: the case-insensitive unique index on
   option values, and `deliverQueuedNotifications` asking for
   `notifications.view`. Both are small, both are outside this programme's
   surface, and both want their own change rather than a line in an audit.
4. R-18 only if a real 404 turns out to matter to something real — a crawl budget
   report, or an uptime monitor somebody actually reads.

---

## 9. Files of particular importance

| Path | Why |
| --- | --- |
| `db/schema/catalog.ts`, `db/schema/variants.ts` | Listing, specifications, variants, options — the legacy fact stores |
| `db/migrations/0014_search_discovery.sql` | `refresh_product_search` and the triggers the search index depends on |
| `db/migrations/0019_seo_pulse.sql`, `db/schema/seo-pulse.ts` | SeoPulse run storage |
| `db/migrator.ts` | Migration ledger rules |
| `lib/catalog/products.ts` | `updateProduct` (slug rule F5, lock F8, audit F9) |
| `lib/catalog/category-attributes.ts` | Current specification validation |
| `lib/catalog/facets.ts` | Facets built from options and specifications |
| `lib/search/{normalize,plan,sql,suggest,synonyms,analytics}.ts` | SearchPulse engine |
| `db/migrations/0036_search_knowledge.sql` | The knowledge-backed index, the facet read model, `search_term_key`/`search_number`, the new queue triggers and `search_events` (D-089, D-090, D-093) |
| `lib/search/terms.ts` | The comparison forms a query and an indexed value must agree on — the twin of `search_term_key` in SQL |
| `lib/search/knowledge.ts` | What the knowledge base says a search means: brands, families, products, controlled values, approved aliases |
| `lib/search/events.ts`, `lib/search/attribution.ts` | Filters, refinements, add-to-cart and conversion, and the cookie that carries a search to the order (D-093) |
| `lib/search/zero-results.ts` | The seven verdicts and their evidence; proposes aliases, never records them (D-094) |
| `lib/seo-pulse/service.ts` | Run, fill, apply (F1–F4) |
| `lib/seo-pulse/facts.ts`, `scores.ts` | Derived tables (F1), scores (F13) |
| `lib/seo.ts`, `app/(storefront)/products/[slug]/page.tsx` | Structured data and the specification tabs |
| `app/sitemap.ts`, `app/robots.ts` | Technical SEO |
| `app/admin/products/[productId]/sections/{basics,specs,seo}-section.tsx` | Editor panels that write facts and SEO fields |
| `lib/auth/authorize.ts` | Permissions |
| `lib/jobs/registry.ts` | Background job kinds |
| `lib/cache.ts` | Cache tags and invalidation by audit entity |
| `db/migrations/0031_product_knowledge_base.sql`, `db/schema/pkb.ts` | Knowledge base schema and its database-enforced rules |
| `lib/pkb/sync.ts`, `projection.ts` | The legacy mirror (D-070) — read before changing any catalogue write path |
| `lib/pkb/store.ts`, `facts.ts` | Fact writes with history, slot states, completeness |
| `lib/pkb/families.ts` | Family schemas, versions, and the category-specification mirror |
| `lib/pkb/evidence.ts` | Sources, evidence, claims |
| `lib/pkb/units.ts`, `normalize.ts`, `identifiers.ts` | Normalization rules shared with SearchPulse in Stage 5 |
| `lib/pkb/maintenance.ts`, `db/pkb-backfill.ts` | Import, job, release, reconciliation report |
| `lib/pkb/resolution.ts` | Product resolution states, identity confirmation, distinctions (D-072) |
| `lib/pkb/mappings.ts` | The reviewed label-mapping workflow and its deterministic reuse (A-8) |
| `lib/pkb/trust.ts`, `lib/pkb/policies.ts` | Brand Source Registry, brand relations, verification policies (A-9) |
| `lib/pkb/discovery.ts` | Attribute proposals: Add to Family, Product only, Ignore (D-073) |
| `lib/pkb/enrichment.ts` | The pipeline: find or receive sources, retrieve, extract, propose (D-074) |
| `lib/pkb/extract.ts` | Deterministic extraction: JSON-LD, HTML tables, definition lists, labelled lines |
| `lib/pkb/net/` | Address policy, pinned-DNS fetch, redirect handling, robots.txt |
| `lib/pkb/review.ts` | Accept, reject, correct, resolve a conflict, lock (D-076) |
| `lib/pkb/intelligence.ts` | The admin read model: one product's intelligence, the queue, the vocabulary |
| `lib/providers/research/` | `ProductResearchProvider`: the default reports NOT_CONFIGURED (A-6); `brave.ts` is the optional credentialed implementation, which returns addresses only (D-114) |
| `lib/preparation/` | Product preparation: the durable run, its state model and the worker that advances it (D-112) |
| `lib/catalog/product-identity.ts` | Manufacturer identity folded into the columns the mirror already reads (D-112) |
| `db/migrations/0043_product_preparation.sql` | The preparation run table, one live run per product (D-112) |
| `lib/seo/fields.ts` | Per-field SEO states, locks and history (D-077) |
| `lib/seo/redirects.ts` | Address stability and old-address redirects (D-078) |
| `lib/seo/structured-data.ts`, `lib/pkb/publish.ts` | Product/ProductGroup JSON-LD from established knowledge (D-080) |
| `lib/seo/readiness.ts` | Measurable readiness checks, replacing the scores (D-081) |
| `lib/seo/health.ts` | Catalogue-wide SEO health counts (D-081) |
| `lib/seo/links.ts` | Internal links from accepted relationships (D-083) |
| `lib/seo/images.ts` | Image SEO findings, catalogue counts, alt suggestions from established values (D-085) |
| `lib/seo/duplicates.ts` | Duplicate, near-duplicate and thin content over the published catalogue (D-086) |
| `lib/seo/technical.ts` | Indexability, canonicals, redirects, shelves and robots (D-087) |
| `lib/seo/audit.ts` | One listing's page audit for the editor |
| `db/migrations/0035_seo_audit.sql` | Category SEO columns and the indexes the duplicate checks use (D-084) |
| `lib/providers/search-console/` | The Search Console boundary: the interface, the unconfigured default, and the only file that reads credentials (D-096) |
| `lib/search-console/sync.ts` | The sync: windows, the watermark, pagination, idempotent storage, failure diagnostics |
| `lib/search-console/metrics.ts` | Connection state, coverage, and every read over the stored measurements |
| `lib/search-console/opportunities.ts` | The five rules, the site's own click-through benchmark, the thresholds, and the decision store (D-097) |
| `lib/search-console/comparison.ts` | The windows either side of a change, and why it never claims a cause (D-099) |
| `lib/search-console/learning.ts` | Recommendations and the guardrails on them (D-100) |
| `lib/search-console/paths.ts` | A Search Console address to a page of this shop, including an address the listing has left |
| `lib/seo/history.ts` | The one SEO change history, for listings and shelves (D-098) |
| `db/migrations/0037_search_console.sql`, `db/schema/search-console.ts` | The measurement key that makes a re-read an update, the sync log, the watermark and the opportunity decisions |
| `db/migrations/0042_search_document_order.sql` | 0036's `refresh_product_search` with the one ordering clause it needed, so the derived search model is rebuildable to the same bytes (I-21, S8-2) |
| `lib/prune.ts` | Bounded, batched deletes for every prune in the maintenance job (D-111) |
| `lib/pkb/legacy-coverage.ts` | The legacy coverage counts (D-103), the search-term migration path (D-105) and the parked-value classification (D-109) |
| `tests/search-document-order.test.ts`, `tests/knowledge-decision-concurrency.test.ts`, `tests/prune.test.ts` | Stage 8's regression tests, each written against a defect that was reproduced first |

---

## 10. Change log

| Date | Stage | Summary |
| --- | --- | --- |
| 2026-09-24 | 9 | Product preparation, backend and orchestration. Identity on the product save (model, MPN, one trade identifier, the official page) folded into the columns the mirror already reads, with a check digit refused at entry and no second identifier store; the mirror re-assessing resolution in the same transaction whenever identity actually changes, which is what left every new product UNRESOLVED; a durable `product_preparation_runs` row (migration 0043) coordinating knowledge sync, resolution, source outlook, enrichment, review, SEO Pulse, the search index and readiness, idempotent by recorded step and one live run per product; `brave` as an optional research provider returning addresses only, with `none` still the default; `groundedKnowledge` giving SEO Pulse what the knowledge base has established, under the publication rule; and `knowledgeSufficiency` reporting too little to write from rather than generating boilerplate and calling it research. Decisions D-112 to D-115; invariants I-23 and I-24. 20 new tests. The product-entry interface is deliberately deferred. |
| 2026-09-24 | 8 | The final audit. Five defects found and fixed, each with a test that fails without its fix: the search document built in plan order rather than a declared one, so a rebuild changed relevance (migration 0042, I-21); a resolution re-check that wrote the knowledge base without asking for permission; an alias decision guarded outside its lock, the third instance of one shape (I-22, D-110); every prune unbounded in both transaction size and memory (D-111); and a development database missing an index because an applied migration had been edited. Verified rather than asserted: one canonical factual store, a derived search model that rebuilds to the same bytes on 25 and on 5,000 listings, a schema identical to one built from zero by the chain, no credential in any client bundle, 49 admin routes and 24 admin pages gated, and R-18's exact consequence measured against a production build. The 72 parked legacy values are classified — 71 ambiguous, 1 unusable, none migratable without guessing (D-109) — and `category_attributes` stays, with the failed proof written out. Decisions D-109 to D-111; invariants I-21 and I-22; R-3, R-10 and R-13 closed; R-15, R-17 and R-18 accepted in writing. typecheck, lint, 109 test files, a production build and the whole browser suite against it: all green. |
| 2026-09-24 | 7 | Hardening. Security: addresses judged after expansion rather than by spelling (two loopback forms were reachable), decompression bounded in zlib, twelve admin routes made strict, source guards for rich text and route shape, data boundaries asserted against the live schema. Write safety: the lost update in `updateProduct` (F8) and the same shape on the SEO apply guard, both proved with real concurrent writes; option renames attributed; `enqueueUniquePending`. Performance, all measured: the search rebuild off the request path (~71 s to 123 ms), the backfill 305 s to 181 s, the reconciliation report 2,434 ms to 511 ms, a page audit 197 ms to 6 ms, the opportunity report 4,867 ms to 737 ms at 20,000 pages, five foreign-key indexes chosen by measuring a delete. Observability: `/admin/jobs`, media coverage, stored-measurement reporting. The legacy contraction was deliberately not done (D-103, D-105), and the coverage report is the gate. Decisions D-101 to D-108; R-2, R-8 to R-10, R-12 and R-16 closed; F17 and R-18 opened. First production build and first full end-to-end run in this repo: both now pass, and both found a defect. |
| 2026-09-18 | 6 | Search Console as an optional intelligence source: migration 0037 (the measurement table keyed so a re-read is an update, the sync log, the per-property watermark, opportunity decisions, and `seo_field_history` widened to cover shelves and record its workflow). A provider boundary whose default reports NOT_CONFIGURED and whose Google implementation is the only file that reads credentials; an idempotent, bounded, paginated sync as a job; five opportunity rules benchmarked against this site's own median click-through per position band; one SEO change history, now covering shelves; before-and-after observation that never claims a cause; controlled learning that recommends and never writes. `/admin/seo-performance`, a box in the listing editor, two API routes. Decisions D-096 to D-100; invariants I-18 to I-20; risks R-15 to R-17. 47 new tests. 0037 applied to the dev database. Google itself UNVERIFIED — no credentials. |
| 2026-09-18 | 5 | SearchPulse on the knowledge base: migration 0036 (four derived columns on `product_search`, the `product_search_attributes` facet read model, `search_term_key`/`search_number`, seven new queue triggers, `search_events`, search attribution on the cart and order lines). Query understanding with approved aliases, brands, families and canonical quantities; attribute-aware matching; ranking tiers 10 and 1; facets and filters on the read model with every older URL key still accepted; knowledge-backed autocomplete; filter, refinement, add-to-cart and confirmed-payment analytics; seven zero-result verdicts with alias proposals. Findings F10, F11 and F12 closed, F14 partly. Decisions D-089 to D-095. 54 new tests; full unit project 1,302 passed. 0036 applied to the dev and scale databases. |
| 2026-09-18 | 4 | Second half of the SEO engine: migration 0035 (category SEO columns, duplicate-check indexes); image SEO, duplicate/near-duplicate/thin content, technical auditing, internal-link intelligence; four new sections on the SEO Health Center and a Page audit panel in the product editor; shelf SEO written by staff and read by the storefront and sitemap. Decisions D-084 to D-088. 11 new tests. 0035 applied to the dev database. |
| 2026-09-17 | 1 | Audit, classification, findings F1–F16, target architecture, source-of-truth matrix, migration strategy, invariants, decisions D-060 to D-069. Documentation only. |
| 2026-09-18 | 4 | SEO engine: migrations 0033 and 0034; per-field states, locks and history; address stability with redirects; canonical restricted to this site; structured data from the knowledge base and the page (ProductGroup, per-variant offers); measurable readiness replacing the weighted scores; SEO Health Center at `/admin/seo-health`; sitemap corrections with image entries; internal links from accepted relationships. Findings F5, F6, F7, F9, F13, F15, F16 closed. 14 new tests; 0033 and 0034 applied to the dev database. |
| 2026-09-18 | 3 | Owner decisions D-071 (A-7 approved, A-8 with a reviewed mapping workflow, A-9 modified, R-6, network safety first). Migration 0032 and `lib/pkb`: resolution, trust registry and policies, reviewed label mappings, attribute discovery, the enrichment pipeline with SSRF-safe retrieval and robots.txt, deterministic extraction, review actions, the intelligence read model. SeoPulse F2–F4 closed (D-075). Admin: `/admin/knowledge`, per-product intelligence screen, seven API routes. 26 new tests; 0032 applied to the dev database. |
| 2026-09-17 | 2 | Owner revised A-4 and A-6. Migration 0031 and `lib/pkb`: normalization, vocabulary, families with versions, facts with history, legacy mirror (D-070), sources/evidence/claims, relationships, aliases, export rule, backfill and report, job, `knowledge.manage`. F1 closed for fill. Imported dev and scale databases cleanly. |
