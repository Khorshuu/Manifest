# Knowledge Platform — Implementation Tracker

The continuity record for the eight-stage programme that puts Manifest on one
Product Knowledge Base (PKB) shared by the storefront, **SeoPulse** and
**SearchPulse**. Read this file first at the start of every stage. It holds the
status, the architecture, the invariants and what comes next; the reasoning
behind each decision is in [DECISIONS.md](DECISIONS.md) (D-060 to D-069).

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
| 2 | PKB database foundation: identity, families, attributes, normalization, variants, provenance, migrations, backfill | MAX | NOT STARTED — waiting for `CONTINUE STAGE 2` |
| 3 | SeoPulse product intelligence: resolution, brand source registry, sources, claims, conflicts, review and apply | EXTRA HIGH | NOT STARTED |
| 4 | SEO engine: metadata states, structured data, technical SEO, image SEO, internal links, SEO Health Center | HIGH | NOT STARTED |
| 5 | SearchPulse: query understanding, aliases, attribute-aware search, typo tolerance, autocomplete, facets, analytics | EXTRA HIGH | NOT STARTED |
| 6 | Google Search Console, opportunity detection, SEO change history, controlled learning | HIGH | NOT STARTED |
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
| F1 | SeoPulse fill copies brand, `details`, category specifications, country of origin and the identifier into an empty `spec_table`, and measurable `details` into an empty `measurements`. The product page already renders those same sources, so a filled listing shows each such row twice (e.g. "Brand"). Two stores now hold one fact. | `lib/seo-pulse/facts.ts` `specificationRows`/`measurementRows`; `service.ts` fill `rows(...)`; `products/[slug]/page.tsx` spec assembly. Latent in dev data (every product already has a `spec_table`, no runs). | 2 (stop), 3 |
| F2 | Fill writes generated description and, with Claude configured, generated key features straight into empty fields of possibly published listings, with no per-field review. | `fillWithSeoPulse` | 3 |
| F3 | Apply is several independent writes (product save, each alt text, each synonym, the run marker, audit) outside one transaction; a failure part-way leaves a partial apply. | `applySeoPulse` | 3 |
| F4 | Research (including the AI and DataForSEO calls) runs inside the admin HTTP request. | `runSeoPulse` | 3, 7 |
| F5 | Renaming a product changes its URL. The Basics panel sends `title` without `slug`, and `updateProduct` rebuilds the slug whenever the title changes, including on published listings; applying SeoPulse's H1 does the same. There is no redirect table, so the old address 404s. | `basics-section.tsx` payload; `updateProduct` slug rule | 4 |
| F6 | `canonical_url` accepts any http(s) address, including another domain. | `httpUrl` in `lib/validation/catalog.ts` | 4 |
| F7 | Product structured data takes `description` from the meta description, which is not visible on the page; carries no SKU/GTIN/MPN, no variants (`ProductGroup`), one image, one offer. | `lib/seo.ts`, product page | 4 |
| F8 | `updateProduct` reads the current row outside its transaction without a lock, so two concurrent saves can lose an update and record stale audit "before" values. | `lib/catalog/products.ts` | 7 |
| F9 | The `product.updated` audit entry records only title, status, slug, searchable and boost; SEO and content field changes leave no before/after. | `updateProduct` | 4, 6 |
| F10 | Brand has no identity; spelling variants cannot be reconciled and the brand facet splits them. | schema | 2 |
| F11 | Category specification units are free text and values raw strings; "256GB" and "256 GB" are different facet values and never compare numerically. | `category_attributes`, facets SQL | 2, 5 |
| F12 | Option names are free text per product; "Color" and "Colour" become two filters. | D-030, facets | 2, 5 |
| F13 | SeoPulse's "Optimization Score" and "Internal Search Score" are weighted 0–100 numbers; the brief rules out score-like ranking figures. | `lib/seo-pulse/scores.ts` | 4 |
| F14 | `search_keywords` mixes aliases, AI-suggested misspellings, phrases and brand variations with no provenance; once stored, the AI label is lost. | fill merge | 5 |
| F15 | Sitemap lists every category including empty ones; no image entries; a product's `lastModified` ignores variant and photo changes. | `app/sitemap.ts` | 4 |
| F16 | SeoPulse decides a variant is available without the closing-date and D-058 rules the storefront uses, so schema readiness can disagree with the page. | `loadPulseInput` | 4 |

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
| Search performance on Google | none | Search Console tables (restricted) | Stage 6 |

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
approved secondary, blocked; tier; notes). Stage 4 adds `seo_field_states`,
`url_redirects`, category SEO columns. Stage 6 adds Search Console tables and
`seo_change_history`.

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
  carry no tier and cannot verify anything.
- **Verification policy** (default, Stage 3 finalizes): VERIFIED needs a human
  acceptance plus at least one tier-1 evidence row whose normalized value
  matches and no open conflict. Accepted with only tier-2/3 evidence →
  UNVERIFIED. Typed by an admin → MANUAL. Backfilled → LEGACY with
  UNKNOWN_LEGACY origin. Nothing is promoted automatically.
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
- Search Console access (Stage 6) reuses `analytics.view` unless a narrower
  permission proves necessary.

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

| # | Invariant | Enforced by (planned) |
| --- | --- | --- |
| I-1 | AI output is never evidence. A claim requires an evidence row from a non-AI source. | FK + check; tests |
| I-2 | Nothing becomes VERIFIED without human acceptance and tier-1 evidence. | review service; tests |
| I-3 | Backfill and migration never produce VERIFIED; legacy data is LEGACY / UNKNOWN_LEGACY. | backfill; tests |
| I-4 | MANUAL and locked values are never overwritten automatically; disagreement becomes CONFLICT. | apply service; tests |
| I-5 | UNKNOWN ≠ false ≠ zero ≠ not applicable. Absence of a row is unknown. | schema (`value_status`); tests |
| I-6 | Raw source value and unit are kept beside the normalized value. | schema not-null rules |
| I-7 | Analysis never mutates accepted facts; only `lib/pkb` apply does, in one transaction with history and audit. | module boundary; lint rule or test on imports |
| I-8 | Offer data (price, stock, capacity) is never stored in or read from the PKB. | schema; review |
| I-9 | No customer PII in `pkb_*`; customer-derived signals only aggregated and thresholded. | schema; review |
| I-10 | Provider-restricted data (DataForSEO, Search Console) is never exportable. | export eligibility function; tests |
| I-11 | Shoppers see only accepted facts; structured data identifiers only VERIFIED or MANUAL. | read models; tests |
| I-12 | After cut-over, a legacy column is written only by the projection. | code search test |
| I-13 | New categories, families and attributes are data operations. | design |
| I-14 | Every PKB mutation checks permission in `lib/`. | existing pattern; boundary e2e |
| I-15 | No outbound fetch without SSRF guard, timeout, size cap and robots check. | Stage 3 fetcher; tests |
| I-16 | Existing checkout, capacity, pricing and publish invariants (BUSINESS_LOGIC.md) are untouched. | existing suites |

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
- **A-4** VERIFIED requires tier-1 evidence; tier-2 corroboration alone gives
  UNVERIFIED.
- **A-5** The one-click "Fill with SeoPulse" (D-040) becomes a proposal and
  review flow in Stage 3. This is a visible change for staff.
- **A-6** Automatic *discovery* of source pages needs a web-search provider,
  which is paid. Without one, sources come from URLs staff add, supplier feeds
  and the brand registry's known documentation. The provider interface reports
  NOT_CONFIGURED rather than guessing URLs.

Open risks:

- **R-1** Production data volume and shape are unknown; the backfill must be
  measured against `manifest_scale` before any real run.
- **R-2** Projection writes add work to product saves; measure in Stage 2.
- **R-3** Findings F1–F16 (section 3.3) remain open until their stages.
- **R-4** Source retrieval introduces outbound HTTP for the first time. The
  SSRF guard (planned for Stage 7) must land with the fetcher in Stage 3, not
  after it — see the note in section 8.

---

## 8. Next stage

**Stage 2 — MAX — Product Knowledge Base and database foundation.**

Entry checklist:

1. Read this file, D-060 to D-069, and `git log` since `1e2e9d3`.
2. Re-profile the development database (section 3.1 query set) in case data
   changed.
3. Finalize the columns of section 4.4; write `0031_product_knowledge_base.sql`
   and `db/schema/pkb.ts`.
4. Build `lib/pkb/units.ts`, identifier and value normalization with unit tests
   (256GB family, 1000 g / 1 kg, GTIN check digits, unparseable input kept raw).
5. Build the fact write service (permission, transaction, history, audit,
   lock and manual protection), the family schema and completeness service,
   and the projection to legacy columns.
6. Build the idempotent backfill with its reconciliation report; run it on
   PGlite, the development database copy and `manifest_scale`.
7. Tests: migration, data model constraints, normalization, variants,
   provenance, targeted integration; plus typecheck and lint.
8. Update this tracker, DATABASE.md, DECISIONS.md.

Scheduling note for the owner, not a change of effort: Stage 3 introduces
fetching pages from the internet. The minimum SSRF protection (private and
metadata address blocking after DNS resolution, redirects re-checked, timeouts,
size caps, robots.txt) should be built in Stage 3 with the fetcher. Stage 7
then reviews and hardens it.

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
| `lib/seo-pulse/service.ts` | Run, fill, apply (F1–F4) |
| `lib/seo-pulse/facts.ts`, `scores.ts` | Derived tables (F1), scores (F13) |
| `lib/seo.ts`, `app/(storefront)/products/[slug]/page.tsx` | Structured data and the specification tabs |
| `app/sitemap.ts`, `app/robots.ts` | Technical SEO |
| `app/admin/products/[productId]/sections/{basics,specs,seo}-section.tsx` | Editor panels that write facts and SEO fields |
| `lib/auth/authorize.ts` | Permissions |
| `lib/jobs/registry.ts` | Background job kinds |
| `lib/cache.ts` | Cache tags and invalidation by audit entity |

---

## 10. Change log

| Date | Stage | Summary |
| --- | --- | --- |
| 2026-09-17 | 1 | Audit, classification, findings F1–F16, target architecture, source-of-truth matrix, migration strategy, invariants, decisions D-060 to D-069. Documentation only. |
