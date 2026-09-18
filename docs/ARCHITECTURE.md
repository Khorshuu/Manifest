# Architecture

## System shape

One Next.js application serves three surfaces from one codebase and one deployment:

- **Storefront** — public, server-rendered for SEO, at `/`.
- **Account** — authenticated customer area, at `/account/*`.
- **Admin** — authenticated staff/super-admin dashboard, at `/admin/*`.

A single app was chosen over separate storefront/admin apps because both share the same domain logic, the same database, and the same auth/session mechanism — splitting them would duplicate all three for no isolation benefit at this scale. See [DECISIONS.md](DECISIONS.md) D-001.

## Layers

```
app/                    routes only: page components, layouts, route handlers
  (storefront)/         customer-facing routes
  account/               authenticated customer routes
  admin/                 authenticated staff/super-admin routes
  api/                   route handlers for webhooks and non-page mutations
    cron/                the scheduled sweep, authenticated by a shared secret
                         rather than by a session

components/             presentational UI, no direct data access

lib/
  auth/                 session creation/validation, password hashing, role checks
  search/               the search engine (DECISIONS.md D-026 to D-030)
    normalize.ts          pure: cleaning, words, codes, tsquery slots
    plan.ts               a search planned: synonyms applied, typo correction
    sql.ts                the match condition and the relevance tiers
    suggest.ts            header autocomplete
    synonyms.ts, history.ts, analytics.ts, maintenance.ts
  catalog/              category tree, attribute/variant combination logic
    discovery.ts          one listing end to end — search page and category
                          pages both call it
    facets.ts             filters, facet counts, sort signals
    filter-params.ts      the URL as state, chips
    recommendations.ts    scored "more like this", never a random draw
    price.ts              the sale-window expression every price query uses, and
                          the one vocabulary for availability
    category-attributes.ts  specifications a category asks its products for,
                          inherited down the tree and validated on every save
    media.ts              product photography: upload, order, promote, describe,
                          and the gallery/lifestyle split
  homepage/             promotional campaigns (campaigns.ts, D-035): five slides of
                          hero + four tiles, read for the storefront, written by
                          `homepage.manage`; hero.ts/showcase.ts are the older
                          keys, now only read to convert them
  admin/                dashboard queries (insights.ts), the live inbox (inbox.ts),
                          customers, staff, exports
  seo-pulse/            SEO Pulse (D-038): research, recommendations, apply
    service.ts            load the product, run, version, reuse, apply
    providers/data.ts     SeoDataProvider — DataForSEO, or none
    providers/intelligence.ts  SeoIntelligenceProvider — Claude, or rules
    rules.ts              recommendations from the product's own data
    sanitize.ts           AI output cleaned and schema-checked before storage
    facts.ts, scores.ts   gaps, identifiers, schema readiness, both scores
    export.ts             JSON, CSV, HTML report
  preorder/             capacity check, reservation, waitlist — the transactional core
  orders/               order creation, status transitions, idempotency
  notifications/        transactional outbox: compose, queue, deliver
  providers/
    payment/            interface + SSLCommerz implementation + mock implementation
    shipping/           interface + courier/tracking implementation + mock implementation
    notification/       interface + email/SMS implementation + mock implementation
  audit/                write-only audit log helper, called from every admin mutation
  validation/           schema definitions (one schema per external input shape)

db/
  schema/               Drizzle table definitions, one file per domain area
  migrations/           checked-in SQL migrations, never edited after merge
```

### Product Knowledge Base (in progress, staged)

Stages 2 to 5 are built. `lib/pkb/` and the `pkb_*` tables hold the knowledge
record, and the catalogue's write paths mirror their legacy columns into it in
the same transaction (D-070). Three readers now use it: structured data
(`lib/seo/structured-data.ts` with `lib/pkb/publish.ts`, Stage 4), the search
index (`product_search.terms` and friends, migration 0036) and the storefront's
facets (`product_search_attributes`), both Stage 5. The product page's
Specification and Measurements tabs still read the legacy columns, which the
projection keeps in step; they move when those columns are contracted in
Stage 7.

Product facts are being moved into one Product Knowledge Base (`lib/pkb/`,
tables `pkb_*`) that the storefront, SeoPulse (`lib/seo-pulse`) and SearchPulse
(`lib/search` with `lib/catalog/{discovery,facets,filter-params}`) read through
read models. `products` stays the listing and `product_variants` the offer;
identity, facts, identifiers, relationships, aliases and their evidence move to
the PKB. SeoPulse and SearchPulse propose; only `lib/pkb` review and apply
services write accepted facts. Until each field is cut over, the existing
columns described on this page remain authoritative. Status, target model,
source-of-truth matrix and migration plan: [KNOWLEDGE_PLATFORM.md](KNOWLEDGE_PLATFORM.md);
reasoning: DECISIONS.md D-060 to D-069.

`lib/seo/` is the SEO engine that reads from both: `index.ts` (origin, JSON-LD
helpers), `structured-data.ts` with `lib/pkb/publish.ts` (Product and
ProductGroup from established knowledge), `fields.ts` (per-field state, locks,
history), `redirects.ts` (address stability), `readiness.ts` (measurable checks
in place of scores), `health.ts` (catalogue-wide counts), `links.ts` (rendered
links from accepted relationships, plus link intelligence), `images.ts` (image
SEO), `duplicates.ts` (duplicate, near-duplicate and thin content),
`technical.ts` (indexability, canonicals, redirects, shelves) and `audit.ts`
(one listing's page audit for the editor), and `history.ts` (the one SEO change
history, covering listings and shelves since Stage 6). Everything under
`lib/seo/` reads; the only writers are `fields.ts`, `redirects.ts` and
`history.ts`, all called from the catalogue's own write paths. Reasoning:
D-077 to D-088 and D-098.

`lib/search-console/` is Stage 6: what Google reports about this shop's pages,
and what those numbers say is worth doing. `sync.ts` brings measurements in as
a job, idempotently; `metrics.ts` reads them; `opportunities.ts` applies five
explicit rules benchmarked against this site's own click-through rate per
position band; `comparison.ts` sets the windows either side of an SEO change
without ever claiming a cause; `learning.ts` turns all of it into
recommendations that need a person. It is optional throughout: with no provider
configured every entry point answers "Search Console not connected" and nothing
else changes. Reasoning: D-096 to D-100.

`lib/search/` is SearchPulse, and since Stage 5 it reads the knowledge base
through two derived tables rather than holding any product truth of its own.
`terms.ts` holds the comparison forms a query and an indexed value must agree
on — the TypeScript twin of `search_term_key` in SQL, and the reuse of
`lib/pkb/units.ts` that makes quantity normalization identical on both sides.
`knowledge.ts` turns the phrases of a search into brands, families, products
and controlled values through approved aliases, in one indexed lookup.
`plan.ts`, `synonyms.ts` and `normalize.ts` build the slots; `sql.ts` turns
them into a match and a relevance tier, where an approved whole-query alias
ranks with an exact code and an attribute-only match ranks last (D-091).
`events.ts` and `attribution.ts` record what people do with a search, and
`zero-results.ts` says why one found nothing. The index (`product_search`) and
the facet read model (`product_search_attributes`) are built by triggers
(migration 0036), never by application code. Reasoning: D-089 to D-095.

The admin product editor is a set of independent panels
(`app/admin/products/[productId]/sections/`), each posting only the fields it
owns to a partial `PATCH`. They share their save behaviour, their controls and
their message treatment through `editor-parts.tsx`, and `product-editor.tsx`
switches between them — a tab strip on a wide screen, a select on a narrow one,
with every panel rendered once and kept mounted so switching never discards an
edit.

Route handlers and server components are thin: validate input against a schema in `lib/validation`, call one function in `lib/`, shape the response. All business rules live in `lib/`, so they are unit-testable without an HTTP layer and are not duplicated between a page and an API route that both need the same rule.

## Request flow: placing a preorder

1. Client posts cart contents plus an idempotency key to a route handler.
2. Route handler validates the request shape only — no price, no capacity, no total is trusted from the client.
3. `lib/orders` opens one database transaction:
   - re-reads each variant's live price and preorder status,
   - calls `lib/preorder` to lock and check remaining capacity (`SELECT ... FOR UPDATE`),
   - increments `preorder_reserved`, inserts the order and its items at server-computed prices,
   - inserts the first `order_status_history` row (`placed`).
4. On commit, `lib/providers/payment` is called to create a payment intent; the order stays `placed` until payment confirms.
5. A payment webhook (or, for the mock provider, a direct confirmation call) transitions the order to `payment_confirmed` through `lib/orders`, which appends to `order_status_history` and queues a message in the `notifications` outbox in the same transaction. Delivery happens afterwards through `lib/providers/notification`, so a slow or failing provider cannot hold a lock on the order (DECISIONS.md D-009).
6. The idempotency key is stored against the resulting order id; a retried request with the same key returns the existing order instead of creating another.

This is the one flow in the system where correctness is non-negotiable (MASTER_PRODUCT_SPEC.md §7), so it is the first thing built after the schema and the first thing covered by integration tests — see [TESTING.md](TESTING.md).

## Authorization

Every route under `/admin` and every mutation checks permissions server-side before doing anything, regardless of what the UI shows or hides. Seven staff roles map to named permissions in `lib/auth/authorize.ts` (D-034): `lib/` functions call `requirePermission`, admin pages call `requireAdminPage(permission)` from `lib/auth/admin-page.ts`, and the admin layout filters its navigation from the same table. See [SECURITY.md](SECURITY.md).

## Provider abstraction

`lib/providers/payment`, `lib/providers/shipping`, and `lib/providers/notification` are interfaces. Each has a mock implementation that simulates success/failure without a network call, selected by an environment variable. This lets every flow — including checkout and order-status progression — run and be tested before SSLCommerz, a courier API, and an SMS/email provider have real credentials, per MASTER_PRODUCT_SPEC.md §7.

SEO Pulse follows the same pattern with two interfaces in `lib/seo-pulse/providers/`: `SeoDataProvider` (external keyword and search-results data; DataForSEO, or none) and `SeoIntelligenceProvider` (writes recommendations; Claude through the Anthropic SDK, or the free rules generator). They are chosen by `SEO_PULSE_DATA_PROVIDER` and `SEO_PULSE_AI_PROVIDER`, read in `lib/seo-pulse/config.ts`. The default — rules, no external data — needs no credentials and costs nothing.

`lib/providers/search-console/` is the same shape again (D-096): one interface
for what is configured and one page of performance rows, a default that reports
`NOT_CONFIGURED`, and `GoogleSearchConsoleProvider` as the only file that reads
credentials — a service-account key signed into a short-lived access token.
Chosen by `SEARCH_CONSOLE_PROVIDER`. Nothing in the platform requires it, and
the rest of `lib/search-console` talks to the interface rather than to Google.

## Rendering strategy

- Cache Components is on (`cacheComponents: true`, DECISIONS.md D-054). Shared catalogue data and the rendered output built only from it are cached with `use cache`; everything about the visitor, and everything a shopper pays or reserves against, is read per request. Pages are server-rendered per request around those cached pieces.
- Cart, checkout, account, and admin pages are dynamic per request — they show per-user state and must never be cached across users.

### Caching map

Cache entries live in the default in-memory handler of the Node.js process. Tags are in `lib/cache.ts` (`CACHE_TAGS`). Staff mutations record an audit entry, and `recordAudit` expires the tags for that entity type after the transaction commits (`invalidateForAudit`, `runAfterCommit` in `db/index.ts`). `tests/cache-invalidation.test.ts` covers each staff change a shopper can see.

| Route | Cached (key → tags, lifetime) | Per request | Notes |
|---|---|---|---|
| Storefront layout | Menu: `cachedCategoryTree` (no args → categories, hours), `cachedCategoryCounts` (→ categories, listing, minutes) | Signed-in user, cart count, search-box history — in `<Suspense>` inside `SiteHeader` | The fallback is the guest header, so most visitors see no change when it resolves. |
| `/` | `HomeCatalogue` rendered output (no args → listing, categories, minutes): shelves bento, new arrivals, assurances; `cachedHomeData` | Campaign slides (`getLiveCampaigns`), server clock for the closing rail | Campaigns stay live because staff check the homepage straight after saving (lost-update and race notes in D-054). |
| `/categories/[slug]` | `CategoryShelf` rendered output (slug + normalized filter key → listing, categories, minutes); `cachedDiscover` | Slug check against the cached tree | Unknown slug renders not-found with `noindex`; status is 200 because the route streams behind `loading.tsx`. |
| `/search` | `SearchResults` rendered output (normalized parameter key → listing, categories, minutes); `cachedDiscover` | Search logging and the visitor's search history, run with `after()` | The key space is open-ended (free-text queries); the in-memory LRU bounds memory. |
| `/products/[slug]` | `cachedProductContent` (slug → productPages, listing, `product:<id>`, minutes): listing, reviews, rating, recommendation rows; `CachedDetailSections` rendered output (slug → same tags): description, specifications, box, warranty, compliance, lifestyle photos | Variants (price, places left, window state), server clock, the visitor, saved variants, review eligibility, recently viewed | A staff preview (`?preview=1`) reads and renders uncached, so drafts never enter a shared entry. |
| `/sitemap.xml` | Whole output (no args → listing, categories, hours) | — | |
| `/api/search/popular` | Whole output (no args → search inspiration, minutes) | — | |
| `/cart`, `/checkout`, `/account/*`, `/orders/lookup`, `/login`, `/register`, `/admin/*` | Nothing | Everything | |

What is deliberately stale for up to a cache lifetime (minutes): places-left figures and closing badges on listing cards and the homepage rail, and sales and rating figures in sorts. Shopper orders do not expire the catalogue, or every checkout would empty it. The product page's buy box, the cart and checkout always read live capacity and price, and checkout re-checks both inside its transaction.
- Client components are limited to interaction: variant selectors, quantity steppers, the admin product wizard's step navigation. They call route handlers; they never compute a price or a total themselves.

## Data access

All database access goes through `lib/` functions using Drizzle. No component or route handler imports the database client directly. This keeps the capacity-check transaction, the audit-log write, and the price-computation logic each defined exactly once.
