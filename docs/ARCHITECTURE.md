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

## Rendering strategy

- Category and product pages are server-rendered with revalidation on catalog change, for SEO and largest-contentful-paint budget.
- Cart, checkout, account, and admin pages are dynamic per request — they show per-user state and must never be cached across users.
- Client components are limited to interaction: variant selectors, quantity steppers, the admin product wizard's step navigation. They call route handlers; they never compute a price or a total themselves.

## Data access

All database access goes through `lib/` functions using Drizzle. No component or route handler imports the database client directly. This keeps the capacity-check transaction, the audit-log write, and the price-computation logic each defined exactly once.
