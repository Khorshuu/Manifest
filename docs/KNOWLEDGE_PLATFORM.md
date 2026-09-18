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
| 7 | Hardening: security, SSRF, write safety, performance, legacy contract, observability, provider abstraction | MAX | NOT STARTED |
| 8 | Final production audit and full verification | ULTRACODE | NOT STARTED |

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
- **R-3** Findings still open: F8 (Stage 7), and the remainder of F14 —
  `search_keywords` survives as listing-level legacy text and is still indexed,
  until Stage 7 contracts it. F1 to F4 are closed (D-075); Stage 4 closed F5,
  F6, F7, F9, F13, F15 and F16; Stage 5 closed F10, F11 and F12 (D-090).
  Stage 6 closed nothing on this list — it added beside the SEO engine rather
  than changing it — but it did close a gap that was never numbered: a shelf's
  SEO fields had no change history at all, and now have one (D-098).
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
- **R-9** (new) `getProductIntelligence` runs `evaluateVerification` once per
  open claim (several queries each). Fine for a product with a handful of open
  claims; batch it in Stage 7 if a run ever proposes dozens.
- **R-10** (new) The SEO Health Center runs five catalogue-wide reads on every
  load. The title and meta-description checks use the expression indexes
  migration 0035 adds; the description-body checks trim before hashing, so they
  do not match that index and scan the published listings instead. Measured only
  on the 24-listing dev database. Measure on the scale database and, if needed,
  cache the screen or align the index in Stage 7.
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
- **R-13** (new, Stage 5) Accepting a claim or approving an alias now queues a
  listing for reindexing through new row-level triggers on `pkb_facts` and
  `pkb_identifiers`. During a bulk import that is one small upsert per fact
  row. The Stage 2 backfill on `manifest_scale` took 176 s before these
  triggers existed; re-measure it in Stage 7 and, if it has grown materially,
  make the backfill queue per listing rather than per fact.
- **R-14** (new, Stage 5) Purchase attribution depends on a first-party cookie
  set by the click beacon. A shopper who blocks it, or who opens a result in a
  way that does not fire the beacon, is simply not attributed — the count
  understates rather than invents, which is the right direction, but the
  conversion figure is a floor and the report says so.
- **R-7** The dev seed's UPC `0812345678901` fails its check digit; it is stored
  as invalid and parked. Seed data only.
- **R-15** (new, Stage 6) `GoogleSearchConsoleProvider` has never spoken to
  Google. It follows the published Search Analytics API and parses defensively,
  and a mismatch surfaces as a provider failure on the sync rather than as a
  stored number, but the first real connection is the first real test. The
  owner supplying credentials, or a staging property, closes this.
- **R-16** (new, Stage 6) `opportunityReport` reads up to 500 pages and 500
  page-and-query rows per window and does the banding in TypeScript. That is one
  indexed read each and fine at this catalogue's size; at a property with tens of
  thousands of pages the limits start truncating rather than slowing, which would
  silently narrow the report. Measure at scale in Stage 7, and either raise the
  limits or say on the screen that the list is truncated. The product editor's
  box deliberately does *not* run this report — it makes three scoped reads —
  so the listing editor does not get slower as the catalogue grows.
- **R-17** (new, Stage 6) The sync stores whatever Search Console reports,
  including pages this shop no longer has. That is deliberate (it is how a
  mis-sent address becomes visible), but it means the table's size is driven by
  Google rather than by the catalogue. `maintenance.prune` deletes past the
  retention window; nothing yet reports the row count back to an operator.

---

## 8. Next stage

**Stage 7 — MAX — hardening: security, write safety, performance, the legacy
contract, observability and the provider abstractions.** Not started, and not to
be started without the owner's `CONTINUE STAGE 7`.

Entry checklist:

1. Read this file (sections 3E, 4.8, 5, 7), D-096 to D-100, and `git log` since
   the Stage 6 commit.
2. Run `npm run pkb:backfill -- --report` against the dev database to confirm
   the mirror is still clean, and check `/admin/seo-performance` renders its
   "Search Console not connected" state.
3. The open findings are F8 (a lost update in `updateProduct`) and the remainder
   of F14 (`search_keywords` still indexed as listing-level legacy text).
4. The open risks are R-2, R-3, R-8 to R-17. R-15 to R-17 are new in Stage 6 and
   are described in section 7.
5. Contracting a legacy column (invariant I-12, D-095) is Stage 7's largest
   piece and the one with the most ways to go wrong. Nothing is dropped before
   the reconciliation report is clean on the target database *and* a test proves
   no reader remains.
6. Performance work has measurements to start from: section 3D.5 for search and
   facets, section 3A.3 for the mirror, and R-16 for the opportunity engine,
   which has never been measured at scale.

**Effort estimate for Stage 7: MAX** — the highest of the remaining stages, and
higher than Stage 6 was. Three reasons. It is the only stage that *removes*
things: contracting `category_attributes`, the legacy option and specification
readers and `search_keywords` touches paths the storefront serves on every
request, and a mistake there is visible to shoppers rather than to staff. It
carries the accumulated risk list from five stages, several of which (R-8
attribution through triggers, F8 concurrent saves) are correctness problems in
write paths rather than additions beside them. And its verification needs the
real-PostgreSQL concurrency suites and measurement at scale, not just the unit
project — which is slower work than anything Stage 6 required.

Stage 6 itself came in about where it was estimated: the parts that could be
built without credentials were ordinary work on top of Stage 4's engine, and
the integration that cannot be verified is marked as such rather than assumed.

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
| `lib/providers/research/` | `ProductResearchProvider`; the default reports NOT_CONFIGURED (A-6) |
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

---

## 10. Change log

| Date | Stage | Summary |
| --- | --- | --- |
| 2026-09-18 | 6 | Search Console as an optional intelligence source: migration 0037 (the measurement table keyed so a re-read is an update, the sync log, the per-property watermark, opportunity decisions, and `seo_field_history` widened to cover shelves and record its workflow). A provider boundary whose default reports NOT_CONFIGURED and whose Google implementation is the only file that reads credentials; an idempotent, bounded, paginated sync as a job; five opportunity rules benchmarked against this site's own median click-through per position band; one SEO change history, now covering shelves; before-and-after observation that never claims a cause; controlled learning that recommends and never writes. `/admin/seo-performance`, a box in the listing editor, two API routes. Decisions D-096 to D-100; invariants I-18 to I-20; risks R-15 to R-17. 47 new tests. 0037 applied to the dev database. Google itself UNVERIFIED — no credentials. |
| 2026-09-18 | 5 | SearchPulse on the knowledge base: migration 0036 (four derived columns on `product_search`, the `product_search_attributes` facet read model, `search_term_key`/`search_number`, seven new queue triggers, `search_events`, search attribution on the cart and order lines). Query understanding with approved aliases, brands, families and canonical quantities; attribute-aware matching; ranking tiers 10 and 1; facets and filters on the read model with every older URL key still accepted; knowledge-backed autocomplete; filter, refinement, add-to-cart and confirmed-payment analytics; seven zero-result verdicts with alias proposals. Findings F10, F11 and F12 closed, F14 partly. Decisions D-089 to D-095. 54 new tests; full unit project 1,302 passed. 0036 applied to the dev and scale databases. |
| 2026-09-18 | 4 | Second half of the SEO engine: migration 0035 (category SEO columns, duplicate-check indexes); image SEO, duplicate/near-duplicate/thin content, technical auditing, internal-link intelligence; four new sections on the SEO Health Center and a Page audit panel in the product editor; shelf SEO written by staff and read by the storefront and sitemap. Decisions D-084 to D-088. 11 new tests. 0035 applied to the dev database. |
| 2026-09-17 | 1 | Audit, classification, findings F1–F16, target architecture, source-of-truth matrix, migration strategy, invariants, decisions D-060 to D-069. Documentation only. |
| 2026-09-18 | 4 | SEO engine: migrations 0033 and 0034; per-field states, locks and history; address stability with redirects; canonical restricted to this site; structured data from the knowledge base and the page (ProductGroup, per-variant offers); measurable readiness replacing the weighted scores; SEO Health Center at `/admin/seo-health`; sitemap corrections with image entries; internal links from accepted relationships. Findings F5, F6, F7, F9, F13, F15, F16 closed. 14 new tests; 0033 and 0034 applied to the dev database. |
| 2026-09-18 | 3 | Owner decisions D-071 (A-7 approved, A-8 with a reviewed mapping workflow, A-9 modified, R-6, network safety first). Migration 0032 and `lib/pkb`: resolution, trust registry and policies, reviewed label mappings, attribute discovery, the enrichment pipeline with SSRF-safe retrieval and robots.txt, deterministic extraction, review actions, the intelligence read model. SeoPulse F2–F4 closed (D-075). Admin: `/admin/knowledge`, per-product intelligence screen, seven API routes. 26 new tests; 0032 applied to the dev database. |
| 2026-09-17 | 2 | Owner revised A-4 and A-6. Migration 0031 and `lib/pkb`: normalization, vocabulary, families with versions, facts with history, legacy mirror (D-070), sources/evidence/claims, relationships, aliases, export rule, backfill and report, job, `knowledge.manage`. F1 closed for fill. Imported dev and scale databases cleanly. |
