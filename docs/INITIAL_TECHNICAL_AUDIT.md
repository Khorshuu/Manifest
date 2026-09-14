# Initial Technical Audit

Date: 2026-09-15 · Commit audited: `6b22ba9` (branch `main`) · Scope: whole repository, read-only.

No application code, schema, configuration or dependency was changed for this
audit. The only artefacts it created outside this file were a scratch database
(`audit_scale`) on the local development PostgreSQL server and throwaway
scripts in a temporary directory; both are described in
[Appendix A](#appendix-a--how-the-measurements-were-taken) and neither is part
of the repository. The scratch database was dropped once measuring finished;
the development database (`preorder`) was only read.

Every performance statement below is labelled with how it is known:

- **Measured** — timed or counted on this machine, with the method in Appendix A.
- **Inspected** — read in the code, with the file named; not exercised under load.
- **Inferred** — a consequence of an inspected fact in a deployment this machine
  cannot reproduce (for example serverless instances or a remote database).

Numbers were taken on one Windows 10 development machine with the database on
the same host. Network latency to a hosted database is therefore absent, which
flatters every query-heavy path; treat them as a lower bound, and as a
comparison between paths rather than as production figures.

---

## Summary for decision-makers

The application is far past a prototype. It is a single Next.js 16 application
with a real PostgreSQL schema, server-side pricing, a locked capacity check, an
order state machine, an audit log, a transactional notification outbox, RBAC
with seven staff roles, a Postgres full-text search engine, 883 passing unit and
integration tests and a Playwright suite of roughly 420 browser tests. The
business rules in `CLAUDE.md` §7 are, with the exceptions below, actually
enforced in `lib/`.

At the target scale (5,000 products, ~19,000 variants, 20,000 customers, 100,000
orders) the database queries themselves mostly stay fast. What does not hold up
is everything around them:

1. **Concurrent checkout deadlocks — measured.** 40 simultaneous two-item
   checkouts that shared the same two products in opposite order: 27 failed
   with `deadlock detected`, 13 succeeded, and the batch took 16.8 s. Any busy
   preorder launch with multi-item carts will hit this.
2. **Nothing is cached — inspected and measured.** Every storefront page is
   `force-dynamic` and re-queries the catalogue per request (11–18 SQL queries
   per listing page). One production Node process served 11–40 requests/second
   on catalogue pages at 20 concurrent users, with median latency 0.5–1.6 s.
3. **Unpaid orders hold preorder slots forever — inspected.** No code path
   expires a `placed` order or releases its reserved capacity.
4. **Retry of the same checkout returns a server error — measured.** Ten
   simultaneous submissions with one idempotency key created exactly one order
   (correct), but nine requests failed with a raw unique-constraint error
   instead of receiving that order.
5. **Deployment plumbing is fragile — inspected.** Migrations have no ledger and
   are all re-executed on every deploy; the mock payment provider keeps state in
   process memory; notification delivery is fire-and-forget plus a once-a-day
   cron; there is no server-side image processing.
6. **Mobile JavaScript is at or over budget — measured.** Summing every script
   a storefront page references gives 628–761 KB raw (194–238 KB gzipped). The
   budget in `DESIGN_GUIDELINES.md` is 200 KB gzipped, and the production e2e
   budget test uses a 640 KB raw ceiling; the product and cart pages exceed it
   by this measure. `PROGRESS.md` last recorded 140.7 KB (product) and 181.4 KB
   (home) gzipped with the e2e test's method, so the two figures are not
   directly comparable, but both leave little room. A ~220 KB-gzipped chunk
   containing Zod is referenced by the checkout route.

None of this needs a new framework. The recommended path keeps Next.js,
PostgreSQL and Drizzle, fixes the concurrency defects first, commits the scale
measurement harness used here so every later change can be proven, and then
adds caching, a listing read model, an image pipeline and a job runner — in that
order. See [§24](#24-proposed-implementation-order).

---

## 1. Current technology stack

Verified from `package.json`, `node_modules` and the build output.

| Layer | Technology | Version | Notes |
| --- | --- | --- | --- |
| Runtime | Node.js | `engines: 22.x`; this machine runs **24.20.0** | Mismatch; see §12 |
| Framework | Next.js App Router, Turbopack | 16.3.4 | `cacheComponents` **not** enabled |
| UI | React / React DOM | 19.2.8 | 78 files marked `"use client"` |
| Language | TypeScript, strict | 5.9.3 | Path alias `@/*` |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss`) | 4.x | Tokens in `app/globals.css` |
| Motion | framer-motion | 13.2.0 | Imported through `components/motion.tsx` |
| ORM | Drizzle ORM + drizzle-kit | 0.45.2 / 0.31.10 | Hand-written SQL in search and facets |
| DB driver | postgres (postgres-js) | 3.4.9 | Pool `max` from `DATABASE_POOL_MAX`, default 10 |
| Database | PostgreSQL | 18.4 locally (embedded-postgres) | Extensions: `pg_trgm`, `plpgsql` |
| Validation | Zod | 4.5.4 | Env, request bodies, JSON settings |
| Passwords | @node-rs/argon2 (argon2id) | 2.2.0 | |
| Media storage | @vercel/blob, or local disk | 2.8.0 | `MEDIA_PROVIDER` = `blob` \| `local` |
| AI (SEO Pulse) | @anthropic-ai/sdk | 0.125.0 | Optional; default provider is rule-based |
| Unit/integration tests | Vitest + PGlite (in-process Postgres) | 5.0 / 0.5.8 | Concurrency suites need a real server |
| E2E tests | Playwright + @axe-core/playwright | 1.63 / 4.13 | Pixel 7 and Desktop Chrome projects |
| Hosting target | Vercel (project `manifest` is linked in `.vercel/`) | — | `vercel.json` declares one daily cron |

`npm audit --omit=dev`: **0 vulnerabilities**. `npm audit` including dev
dependencies: 4 moderate, all through `drizzle-kit`'s toolchain (not shipped).
`npm outdated`: patch/minor updates only for the runtime (Next 16.3.5, React
19.3.0, Zod 4.6.5); no major upgrade is pending except optional TypeScript 7
and ESLint 10.

## 2. Current architecture

One Next.js application serves three surfaces from one deployment
(`docs/ARCHITECTURE.md`, verified against `app/`):

```
Browser ──► Next.js (Vercel functions or `next start`)
             ├─ app/(storefront)/*   public pages + /account/*   (all force-dynamic)
             ├─ app/admin/*          staff dashboard            (all force-dynamic)
             ├─ app/api/*            58 route handler files (JSON)
             └─ app/uploads/[key]    local media file server
                    │
                    ▼
             lib/  — all business rules (auth, catalog, preorder, orders, cart,
                     search, notifications, pricing, providers, seo-pulse, admin)
                    │
                    ▼
             db/ — Drizzle schema + 23 hand-written SQL migrations
                    │
                    ▼
             PostgreSQL (triggers maintain the search index)

Providers behind interfaces: payment (mock only), shipping (mock only),
notification (mock only), media (local | Vercel Blob), SEO data/AI (none | paid).
```

Strengths confirmed in the code:

- Route handlers are thin; they validate with Zod and call one `lib/` function.
  Permission checks live inside `lib/` (`requirePermission`), so a future route
  or script cannot bypass them.
- Customer-facing and staff-facing reads are separate functions, so supplier
  cost and internal notes are excluded structurally rather than by a flag.
- Prices are never taken from the client: the cart, the order and the product
  card all read one SQL expression, `effectivePriceSql` (`lib/catalog/price.ts`).

There is no `middleware.ts`/`proxy.ts`; admin protection is done per page by
`requireAdminPage()` and per function by `requirePermission()`.

## 3. Current database architecture

**Inspected:** `db/schema/*.ts` (12 files), `db/migrations/0000`–`0022`,
`docs/DATABASE.md`.

- 41 tables. Money is integer minor units with currency suffixes (`_bdt`, `_usd`).
- Catalogue: `categories` (self-referencing, unlimited depth), `products` (many
  JSONB detail columns), `product_images`, `category_attributes` (specifications,
  answered in `products.attribute_values` JSONB), `attributes` /
  `attribute_values` / `product_attributes` / `variant_option_values` (EAV
  variation system, product-scoped since migration 0020), `product_variants`
  (price, sale window, stock, preorder capacity/reserved, deposit mode),
  `variant_images`, `waitlist_entries`, `inventory_adjustments`, `sku_reservations`.
- Commerce: `carts`, `cart_items`, `wishlist_items`, `orders` (unique
  `idempotency_key`, `order_number` from a sequence), `order_items` (price,
  title, SKU, options and image snapshotted), `order_status_history`, `payments`
  (refunds link to the charge they reverse), `addresses` (never edited in place
  once an order used them).
- Integrity is enforced in the database as well as in code: check constraints
  for statuses, `preorder_reserved <= preorder_capacity`, non-negative
  reservations, sale price ≤ price, deposit percent range.
- Search: `product_search` (weighted `tsvector` + normalised title/brand/code
  columns), `product_search_words` (trigram vocabulary), a queue table, synonyms,
  query/click analytics. **Triggers** on six catalogue tables queue affected
  products and a deferred constraint trigger rebuilds their index rows at commit.
- Operations: `audit_log`, `notifications` (outbox with `dedupe_key`),
  `rate_limit_hits`, `sessions` (SHA-256 of token), `recovery_codes`,
  `oauth_accounts`, `site_settings` (JSON key/value), `seo_research_runs`.

**Migrations — inspected.** `db/migrate.ts` reads every `.sql` file, splits on
`--> statement-breakpoint`, executes each statement outside any transaction, and
ignores errors whose message matches `/already exists/`. There is no table
recording which migrations have run. `drizzle-kit` metadata
(`db/migrations/meta/`) holds snapshots only for 0000–0002, so
`npm run db:generate` would diff against a schema 20 migrations old.

**Indexes — inspected** (35 declared in the schema, plus search indexes in
0012–0014). Present where the obvious foreign-key and status reads need them.
Absent, and relevant at scale: `orders (placed_at)` on its own and
`orders (status, placed_at)`; any trigram index for admin search over
`users.email`, `orders.order_number`, `orders.guest_email`;
`cart_items (variant_id)`; `sessions (expires_at)`.

**Size today — measured.** The development database holds 35 products, 37
variants, 12 categories, 5 users and 7 orders (14 MB). Nothing in the working
database resembles the target scale, which is why a synthetic database was built
for this audit.

## 4. Current frontend architecture

- App Router with a `(storefront)` route group, `/account/*` inside it, and
  `/admin/*`. Server Components fetch data; client components handle
  interaction (variant picker, gallery, filters, search box, crop editor,
  admin editors). 78 client component files.
- Design system: Tailwind v4 tokens in `app/globals.css`, shared primitives in
  `components/` (`button`, `field`, `panel`, `product-card`, `media-image`,
  `skeleton`…), guidelines in `docs/DESIGN_GUIDELINES.md` (plus D-044–D-051 for
  phone behaviour).
- Every page in the storefront, account and admin exports
  `dynamic = "force-dynamic"`; the storefront layout does too, because the header
  reads the category tree, per-category counts, the session and the cart count.
  Only `/_not-found` and `/robots.txt` are static in the build output.
- Images go through `components/media-image.tsx` → `next/image` with `sizes`,
  except SVGs, which are rendered with a plain `<img>`. Only this one component
  imports `next/image`.
- `loading.tsx` skeletons exist for the heavier routes; `after()` is used only on
  the search page to log analytics.
- Accessibility is tested: `e2e/accessibility.spec.ts` runs axe at WCAG 2.1 AA
  on twelve pages in both viewports.

## 5. Current backend architecture

- **58 route handler files** under `app/api/`. Admin mutations are JSON `POST`/`PATCH`
  endpoints; there are no Server Actions.
- **Auth** (`lib/auth/`): argon2id passwords; opaque session token in an
  HTTP-only `SameSite=Lax` cookie, database stores its SHA-256; one session read
  per request, memoised with `React.cache`; optional TOTP two-factor with
  single-use recovery codes; optional Google OAuth. Login throttling counts in
  Postgres (`rate_limit_hits`, one atomic upsert) and **fails open** if the
  database errors. Search/suggest throttling is an in-memory `Map` per process.
- **RBAC** (`lib/auth/authorize.ts`): eight roles (`customer` + seven staff) mapped
  to named permission lists; `requirePermission` in every mutating `lib/`
  function. Customer media/listing uploads are refused inside `lib/catalog/media.ts`.
- **Preorder engine** (`lib/preorder/capacity.ts`): `SELECT … FOR UPDATE` on the
  variant, re-evaluate availability, increment `preorder_reserved` or decrement
  `stock_quantity`, all inside the caller's transaction. Release clamps at zero
  and queues waitlist notifications in the same transaction.
- **Order placement** (`lib/orders/place.ts`): idempotency pre-check → address
  ownership → read settings → one transaction (read cart lines at live price,
  snapshot options/images, reserve each line, insert order, items, history,
  empty cart, queue notification) → *after commit* call the payment provider and
  insert the `payments` row → fire background notification delivery.
- **Payment confirmation** (`lib/orders/confirm.ts`): look up by `provider_ref`,
  call `provider.capture`, then a guarded `UPDATE … WHERE status='initiated'` so
  only one caller transitions the order. Exposed publicly at
  `POST /api/checkout/confirm` as the stand-in for a gateway webhook.
- **Order pipeline** (`lib/orders/transitions.ts`): forward-only transitions,
  cancellation requests reviewed by staff, refunds recorded per charge, shipping
  booked through the provider interface.
- **Providers** (`lib/providers/`): payment, shipping, notification — mock only;
  `PAYMENT_PROVIDER=sslcommerz` throws "not implemented". Media — local disk or
  Vercel Blob.
- **Scheduled work** (`app/api/cron/maintenance`): bearer-secret protected;
  delivers up to 100 notifications, prunes rate limits, sessions and search
  logs, retries failed search-index rows, releases expired SKU holds. Scheduled
  **once a day** (`vercel.json`, Vercel Hobby limit per README).

## 6. Current infrastructure

- **Local:** `npm run db:server` starts embedded PostgreSQL 18.4 on port 5432
  (`.postgres-dev/`), `npm run dev` on port 3000. `.env.local` points at the
  local database with `MEDIA_PROVIDER=local` and all providers `mock`.
- **Deployment:** Vercel. `vercel-build` runs `db/migrate.ts` then `next build`.
  README names Neon as the intended database. A daily cron calls the
  maintenance endpoint. Vercel Blob is required for uploads on Vercel; without a
  Blob token, uploads fail there (README "Known limitation").
- **Not present:** CI configuration (no `.github/`), infrastructure-as-code,
  error tracking/APM, structured logging, uptime monitoring, backups policy,
  staging environment definition, CDN configuration beyond Vercel defaults,
  a remote cache or queue.

## 7. Current image/media pipeline

**Inspected** (`lib/providers/media/*`, `lib/catalog/media.ts`,
`app/uploads/[key]/route.ts`, `components/media-image.tsx`,
`lib/images/crop.ts`, `app/admin/products/[productId]/crop-editor.tsx`):

1. Staff crop the photograph **in the browser** (D-049) and upload the result.
2. The server checks size (≤ 5 MB), sniffs magic bytes (JPEG/PNG/WebP/AVIF only),
   rejects a declared/actual type mismatch, and stores the **original bytes
   unchanged** under a random UUID name.
3. `local` provider: file written to `.uploads/`, served by a route handler that
   reads the whole file from disk on every request with a one-year immutable
   cache header. `blob` provider: public Vercel Blob URL.
4. Pages render through `next/image`, which resizes on demand via
   `/_next/image`. SVGs bypass it.
5. Replacing an image keeps the old file (orders reference it); removing one
   deletes the row, then the file.

What is **not** there: server-side resizing or re-encoding at upload,
generated derivative sizes, stored width/height, blur placeholders, EXIF
stripping, pixel-dimension limits, CDN image transforms other than
`next/image`, or orphan clean-up. `docs/SECURITY.md` states uploads "are
re-encoded to a fixed set of output sizes rather than served as-uploaded"; the
code does not do this (documentation drift, §11).

**Measured:** 250 uploaded files in `.uploads/` total 5.2 MB; the largest is
429 KB. The seeded catalogue uses SVG artwork, so the `next/image` optimiser has
not been exercised with the seed data.

## 8. Current performance characteristics

All **measured** against the synthetic `audit_scale` database (5,000 products,
18,731 variants, 25,000 images, 150 leaf categories, 20,001 users, 100,000
orders, 200,203 order items, 59,915 reviews, 50,000 audit rows; 305 MB).

### 8.1 Build and bundle

| Check | Result |
| --- | --- |
| `next build` | passes, 2 min 46 s (compile 2.2 min) |
| Static routes | 2 of 101 (`/_not-found`, `/robots.txt`) |
| Client chunks | 47 files, 2.3 MB raw total |
| Largest chunk | 827 KB raw / 220 KB gzip, contains Zod; referenced by the `/checkout` client manifest |

### 8.2 Data functions (median of 5 warm runs, single caller)

| Path | Median | Queries |
| --- | ---: | ---: |
| Storefront header (category tree + counts), every page | 4 ms | 2 |
| Homepage data (all parallel) | 29 ms | 11 |
| Category page, root shelf ~1,000 products, `featured` | 76 ms | 18 |
| Same, `best_selling` | 123 ms | — |
| Same, brand + spec + price filters | 216 ms | — |
| Whole catalogue sorted `best_selling` | **422 ms** | — |
| Search `wireless headphones` / `skillet` | 40 / 90 ms | 18 |
| Product page core, 6 variants / 250 variants | 47 / 54 ms | 15 |
| Admin overview (8 parallel reads) | 307 ms | — |
| Admin products list (loads all 5,000 rows) | 195 ms | 1 |
| Admin orders list, page 1 / page 1,000 | 278 / 369 ms | 2 |
| Admin orders search `u123` | 193 ms | 2 |
| `listOrdersForStaff` (unpaged, 100,000 rows; no page calls it today) | 271 ms | 1 |
| CSV export of all orders (8 MB string in memory) | **960 ms** | 1 |
| Search index rebuild triggered by inserting 5,000 products / 18,731 variants / 18,731 option rows | 15.6 s / 19.9 s / 19.8 s | — |

### 8.3 HTTP (production build, one `next start` process, local database)

10 serial requests, then 100 requests from 20 concurrent clients.

| Page | Serial p50 | c=20 p50 / p95 | Throughput | HTML (gzip) | First-load JS (gzip) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/` | 62 ms | 510 / 615 ms | 39.5 req/s | 212 KB (23) | 198 KB |
| `/categories/root-1` (~1,000 products) | 112 ms | 1,060 / 1,135 ms | 18.8 req/s | 413 KB (30) | 194 KB |
| `/categories/…leaf-1` | 42 ms | 553 / 631 ms | 36.6 req/s | 279 KB (24) | 194 KB |
| `/search?q=wireless` | 185 ms | 608 / 751 ms | 32.1 req/s | 150 KB (18) | 195 KB |
| `/search?q=skillet&sort=price_asc` | 94 ms | 902 / 1,083 ms | 21.6 req/s | 325 KB (27) | 195 KB |
| `/products/p-1001` (6 variants) | 78 ms | 637 / 748 ms | 30.9 req/s | 298 KB (30) | 206 KB |
| `/products/p-3000` (250 variants) | 124 ms | 1,632 / 2,277 ms | 11.5 req/s | 444 KB (56) | 206 KB |
| `/cart` (empty) | 16 ms | 115 / 167 ms | 169 req/s | 79 KB (12) | 238 KB |
| `/sitemap.xml` (5,000 URLs) | 30 ms | 304 / 469 ms | 59.4 req/s | 865 KB (15) | — |

`/checkout` redirected (empty cart), so its JavaScript was not weighed over HTTP.

Reading these numbers: a single catalogue request is fast; the cost is that
**every** request renders from scratch. With 20 concurrent shoppers one process
spends 0.5–1.6 s per catalogue page, and throughput is bounded by rendering
and query fan-out rather than by any single slow query. On Vercel each instance
behaves like this process, with added database round-trip latency on each of
the 11–18 queries.

## 9. Current scalability risks

| # | Risk | Evidence | Target it threatens |
| --- | --- | --- | --- |
| S1 | Checkout deadlocks when carts share variants | **Measured**: 27/40 failed | High-concurrency preorders |
| S2 | No caching of any catalogue read; full render per request | **Measured** §8.3; `force-dynamic` everywhere | Mobile storefront, traffic spikes |
| S3 | Unpaid orders reserve capacity indefinitely | **Inspected**: no expiry in `lib/orders`, cron, or providers; the admin inbox only *flags* orders "still unpaid after a day" | Preorder capacity accuracy |
| S4 | Listing sorts compute sales/rating/discount as correlated subqueries over every matching product | **Measured**: 422 ms whole-catalogue `best_selling`; grows with orders × products | 5,000+ products, large order history |
| S5 | Admin product list loads the whole catalogue with 9 subqueries per row | **Measured**: 5,000 rows, 195 ms before rendering | Powerful admin dashboard |
| S6 | CSV export builds the entire file in memory | **Measured**: 960 ms and 8 MB at 100k orders | Large order history, serverless memory/time limits |
| S7 | Search index rebuilt synchronously inside the writing transaction | **Measured**: ~3–4 ms per product per touched table | Bulk imports and bulk edits |
| S8 | Connection pool of 10 per process, no pooler configured, 11–18 queries per page | **Inspected** `db/index.ts`; **inferred** for serverless fan-out | 20,000+ customers, spikes |
| S9 | Notification delivery is fire-and-forget without `after()`; the only reliable drain runs once a day; concurrent drains do not claim rows | **Inspected** `lib/notifications/outbox.ts`, `vercel.json` | Order communications at volume |
| S10 | In-memory state in a multi-instance deployment: mock payment intents, search throttle | **Inspected** `lib/providers/payment/mock.ts`, `lib/search/throttle.ts` | Any multi-instance deploy |
| S11 | Product page HTML grows with variant count (444 KB for 250 variants) | **Measured** | Large numbers of variants |
| S12 | No server-side image derivatives; originals up to 5 MB stored and resized on demand | **Inspected** | Heavy product imagery |
| S13 | Offset pagination for admin lists | **Measured**: page 1,000 of orders 369 ms | Large order history |

## 10. Current security risks

Ordered by severity. Nothing here was found to break the core server-side price
or permission rules.

| # | Risk | Evidence | Severity |
| --- | --- | --- | --- |
| X1 | `POST /api/checkout/confirm` is public and unauthenticated. It confirms payment for any known `provider_ref`. With the mock provider in production an order can be marked paid without money moving. The reference is a random UUID not returned to the browser, which limits practical abuse today, but the route has no production guard and no signature check. | **Inspected** `app/api/checkout/confirm/route.ts` | High before real launch |
| X2 | Payment row is written after the order transaction commits; if the provider call throws, the order exists, capacity is held, and no payment row records the attempt. | **Inspected** `lib/orders/place.ts:320-340` | Medium (data integrity) |
| X3 | `confirmPayment` calls `provider.capture` before the guarded status update, so duplicate concurrent webhooks call capture twice against the gateway. | **Inspected** `lib/orders/confirm.ts` | Medium once a real gateway exists |
| X4 | Content-Security-Policy allows `'unsafe-inline'` scripts in production. | **Inspected** `next.config.ts` | Medium (XSS blast radius) |
| X5 | Login rate limiter fails open when the database errors. Deliberate and documented, but it removes brute-force protection during a partial outage. | **Inspected** `lib/rate-limit.ts` | Low–medium |
| X6 | No explicit Origin/CSRF check on cookie-authenticated JSON mutations; protection relies on `SameSite=Lax` and the JSON content type forcing a CORS preflight. | **Inspected** `app/api/**` | Low |
| X7 | Search/suggest throttles are per process, so they are approximate across instances. | **Inspected** | Low |
| X8 | Uploaded images are stored as uploaded: EXIF (including GPS) is kept, and no decompression/pixel limit exists. | **Inspected** | Low–medium |
| X9 | Documentation claims controls that do not exist: password-reset tokens (no reset flow exists), webhook signature verification (no webhook exists), image re-encoding. A reviewer reading `SECURITY.md` would believe these are in place. | **Inspected** `docs/SECURITY.md` vs `lib/`, `app/api/` | Medium (process) |

Confirmed in place: argon2id; hashed session tokens with server-side revocation;
TOTP with replay protection; permission checks inside `lib/`; no client-supplied
prices; customer/staff read separation; upload magic-byte sniffing and generated
filenames; strict upload-key regex; CSV formula-injection guard; `nosniff`,
`frame-ancestors 'none'`, HSTS in production; audit log written in the same
transaction as admin mutations.

## 11. Current technical debt

1. **Migration runner without a ledger** (§3). Every deploy re-executes all 23
   migrations; migration 0014 drops and recreates the search triggers each time,
   and statements run outside a transaction, so a failure mid-file leaves a
   partly applied migration that the "already exists" filter then hides.
2. **Stale drizzle-kit metadata** (snapshots stop at 0002), making
   `db:generate` unsafe to use.
3. **Documentation drift.** `ARCHITECTURE.md` says category and product pages
   are "server-rendered with revalidation on catalog change" (they are
   `force-dynamic`). `DATABASE.md` still opens with a three-role `users.role`
   (there are eight). `SECURITY.md` items in X9. Media docs still name
   Cloudflare R2 (the implementation is Vercel Blob).
4. **Very large living docs.** `PROGRESS.md` is 188 KB (~2,850 lines) and
   `DECISIONS.md` 84 KB. They are valuable history but no longer a fast way to
   learn current state.
5. **Mock-only providers** for payment, shipping and notification, with
   `sslcommerz` hard-failing. Expected per spec, but the interfaces have not yet
   been tested against a real gateway's asynchronous, signed-webhook shape.
6. **Client/server module boundary leaks**: `checkout-form.tsx` imports
   `@/lib/providers/payment`, whose index imports `@/lib/env` (Zod) and the mock
   provider (Node crypto) — likely why a 220 KB-gzip chunk reaches `/checkout`.
7. **Unused or unbounded helpers**: `listOrdersForStaff` (unpaged, no callers),
   `listOrdersForUser` (reads every order then slices), whole-table exports.
8. **Two attribute systems** (variation EAV and category specifications) merged
   at query time with `jsonb_array_elements_text` laterals in facets. Correct
   and documented (D-025/D-030), but costly to query and to reason about.
9. **Stray files**: untracked `.fix.mjs` edits a `.search-edit.mjs` that no
   longer exists; a test product "Crop Test v13ejd" is recorded as left in the
   development database.
10. **No CI**: every quality gate is run by hand.

## 12. Current bugs, errors and warnings

**Measured in this audit:**

| Item | Detail |
| --- | --- |
| Deadlock under concurrent multi-line checkout | 27 of 40 checkouts: `deadlock detected`. Cause (inspected): `placeOrder` reads cart lines without an `ORDER BY` and locks each variant in that order, so two carts containing the same variants in different order lock them in opposite sequence. |
| Concurrent duplicate submission returns an error | 10 simultaneous `placeOrder` calls with one idempotency key: 1 order created (correct), 9 rejected with `duplicate key value violates unique constraint "orders_idempotency_key_unique"` rather than returning the existing order. These errors carry no `status`, so `toErrorResponse` (`lib/api-error.ts`) answers HTTP 500 "Something went wrong"; the deadlock failures take the same path. |
| Node version mismatch | `package.json` pins `22.x`; local runtime is 24.20.0. Vercel will build on 22; tests here ran on 24. |
| Vitest warning | Config loaded as CommonJS; `vite-tsconfig-paths` redundant with native `resolve.tsconfigPaths` (known since Phase 1). |
| Noisy test log | A unit test deliberately exercises the fail-open rate limiter and prints a full `DrizzleQueryError` stack. |
| Mock payment state is per process | **Inspected**: an intent created on one instance cannot be captured on another or after a restart (`Unknown payment reference`). |
| Mock gateway redirect target does not exist | **Inspected**: `redirectUrl` points at `/checkout/mock-gateway`, which has no route; the checkout form ignores it today. |

**Build/typecheck/lint:** no errors, no warnings.

**End-to-end suite:** 55 of 446 tests failed against the production build (§13).
`PROGRESS.md` had already recorded failures in `cancellation-requests`,
`reviews` and `admin-variants`. The larger count now is in checkout-dependent
specs (landed price, shipping, notifications, cron, analytics), which all use an
add-to-cart helper that timed out.

## 13. Current testing coverage

| Gate | Command | Result in this audit |
| --- | --- | --- |
| Typecheck | `tsc --noEmit` | **Pass**, no errors |
| Lint | `eslint` | **Pass**, no warnings |
| Unit + integration | `vitest run` | **Pass** — 56 files, 883 passed, 2 skipped, 100.7 s |
| Production build | `next build` | **Pass**, 2 min 46 s |
| End-to-end (production build) | `playwright test`, both projects | **Fail** — 446 tests: 385 passed, 55 failed, 6 skipped, 14.4 min. Both JavaScript budget tests passed. |

The 55 failures fall into 14 spec areas, most failing in both viewports:
analytics (5), cancellation requests (4), landed price (4), shipping (5),
notifications (2), cron (1), reviews (1), preorder windows (1), security sign-out
(1), SEO layout shift (1), accessibility on the admin preorder-windows page (1,
one serious axe violation: "Elements must only use permitted ARIA attributes" on
the loading skeleton `<div aria-busy="true" aria-label="Loading product">`), plus admin variants (mobile only), autosuggest and search
visibility (desktop only). The dominant symptoms are 180-second timeouts
waiting for the add-to-cart `POST /api/cart` in a shared order-placing helper,
and selectors that now match two elements (for example
`getByText('Orders placed')` finds both an admin KPI label and a second label).
Both point at specs that have not kept up with recent storefront and admin
layout changes rather than at broken business rules, but that was not proven
test by test in this audit. The production server also logged 99
`The destination stream closed early` errors, which is what a streamed page
reports when the browser navigates away mid-render.

Until this is fixed, the end-to-end suite cannot be trusted as a regression
gate: a real checkout, shipping or notification regression would be hidden
among existing failures.

What the suites cover well (inspected): capacity reservation including a
real-server race test for a **single** variant, idempotent placement (sequential
retry), order transitions, refunds, RBAC for every catalogue mutation, search
ranking, facets, settings, two-factor, TOTP vectors, CSV escaping, migrations
applied from scratch, axe accessibility on twelve pages.

Gaps:

- No concurrency test with **multi-line** carts (the deadlock above) or with
  **simultaneous** same-key submissions.
- No test data at scale; all suites run on a few dozen products.
- No load test, query-count assertion, or query-plan check.
- No performance budget enforced in CI (the JS budget assertion exists only in
  the production e2e run, which is run by hand).
- No test of migrations applied **on top of an existing database** (the deploy
  path), only from empty.
- No coverage reporting configured.
- No CI to run any of it automatically.

## 14. Top performance bottlenecks

Ranked by measured impact on the shopper.

1. **Uncached, per-request rendering of the whole storefront.** Measured
   throughput of 11–40 req/s per process on catalogue pages at 20 concurrent
   users; medians 0.5–1.6 s. The data barely changes between requests.
2. **Query fan-out per page.** 11 (home), 15 (product core, before reviews and
   session), 18 (category/search). Locally this costs little; against a hosted
   database each round trip adds latency and holds a pool connection.
3. **Correlated-subquery sorts and facet scans.** 422 ms for a whole-catalogue
   `best_selling`; 216 ms for a filtered category; these scale with catalogue and
   order-history size together.
4. **Variant-heavy product pages.** 250 variants: p50 1.6 s and p95 2.3 s under
   concurrency, 444 KB of HTML.
5. **First-load JavaScript** of 194–238 KB gzipped on every storefront page,
   before images, on mobile networks.
6. **Admin list and export paths** that load entire tables (5,000 products,
   100,000-order export).

## 15. Top scalability risks

1. **Checkout deadlocks** (S1) — fails real orders exactly when demand peaks.
2. **Capacity leak from unpaid orders** (S3) — preorders show "full" while slots
   are held by orders nobody will pay for.
3. **No caching** (S2) — cost and latency grow linearly with traffic.
4. **Database connections under serverless fan-out** (S8) — many instances × pool
   of 10 can exhaust a hosted Postgres without a pooler.
5. **Background work tied to requests and a daily cron** (S9, S10) — messages
   delayed up to a day; state lost between instances.
6. **Listing aggregates computed at read time** (S4) — gets slower as sales grow,
   which is the opposite of what a growing shop needs.
7. **Image originals without derivatives** (S12) — bandwidth and optimiser cost
   grow with catalogue imagery.

## 16. Recommended architecture

Keep the current shape — one Next.js app, `lib/` as the domain layer, PostgreSQL
as the system of record. It already separates concerns well, and splitting it
into services would add network hops and failure modes without solving any
measured problem.

Change what sits around it:

```
                    ┌──────────── CDN / Vercel edge ───────────┐
Browser ──────────► │ static shell + cached catalogue segments │
                    └───────────────┬──────────────────────────┘
                                    ▼
             Next.js (Cache Components)
               ├─ cached, tag-invalidated: category tree, counts, product
               │  cards, product detail, facets for common listings
               ├─ per-request, in <Suspense>: session, cart, wishlist,
               │  live capacity/price on the buy box
               └─ route handlers (thin) ──► lib/ (unchanged responsibilities)
                                    │
             PostgreSQL via a pooler (Neon pooled endpoint)
               ├─ transactional tables (unchanged)
               ├─ product_listing read model (aggregates maintained on write)
               └─ job queue table (or managed queue)
                                    │
             Job runner (frequent schedule or queue consumer)
               notifications · unpaid-order expiry · search reindex batches ·
               image derivatives · exports · gateway reconciliation
                                    │
             Object storage + image CDN for product media
```

Why each part:

- **Cached catalogue segments with tag invalidation** — catalogue data changes
  when staff edit it, not per request; caching turns the measured per-request
  cost into a per-edit cost. Live price and capacity stay uncached on the buy
  box, so server truth is never stale where money is decided.
- **Read model for listings** — sorting and filtering by sales, rating, price and
  discount should read columns, not recompute aggregates across order history
  on every page view.
- **Pooler** — serverless instances each open their own pool; a pooler caps
  real connections at what the database can hold.
- **Job runner** — expiry, delivery, reindexing and exports must happen whether
  or not a shopper happens to make a request, and must not run inside a
  checkout transaction.
- **Image CDN with derivatives** — the heaviest bytes on a phone should be
  produced once and served from the edge.

## 17. Recommended technology changes, if any

No change of framework, language, database or ORM is recommended. Each
addition below solves a measured or inspected problem and is optional until its
phase arrives.

| Change | Why | Alternative considered |
| --- | --- | --- |
| Enable Next.js `cacheComponents` incrementally (`use cache`, `cacheLife`, `cacheTag`, `updateTag`/`revalidateTag`) | The framework's own caching model in this Next version; `force-dynamic` is obsolete under it and routes can be migrated one at a time with `instant = false` (per `node_modules/next/dist/docs/01-app/02-guides/migrating-to-cache-components.md`) | `unstable_cache` — the previous model, not the direction of this Next version |
| Migration ledger: `drizzle-kit migrate` (journal table) or a small `schema_migrations` table in `db/migrate.ts`, each file in a transaction | Run each migration once, atomically, and know what production has | Keep current runner — measured risk of re-running triggers and hiding partial failures |
| Neon **pooled** connection string in production, pool size tuned per instance, `prepare` setting verified against the pooler | Serverless connection fan-out | Self-hosted PgBouncer — more to operate |
| `sharp` for upload-time derivatives (or an image CDN with transforms) | No derivatives today; strip EXIF; enforce pixel limits | Rely on `/_next/image` alone — works but pays per transform and keeps originals |
| A job runner: Vercel Cron at a sub-hourly schedule plus a Postgres job table with `FOR UPDATE SKIP LOCKED`, or a managed queue (e.g. Upstash QStash, Inngest) | Reliable delivery/expiry independent of traffic | Keep daily cron — messages up to 24 h late |
| Shared store for throttles and remote cache handler **only if** multi-region or high instance counts make per-process limits too loose (e.g. Upstash Redis) | Global rate limits | Postgres counters — already used for login; fine for low-rate endpoints |
| Error tracking and request tracing (e.g. Sentry, Vercel Observability) | Nothing reports production failures today | Logs only |
| CI (GitHub Actions or Vercel checks) running typecheck, lint, unit, build, targeted e2e | Quality gates are manual | — |

## 18. Recommended image optimisation strategy

1. **Keep browser-side cropping** (it gives staff control) but treat its output
   as an original, not the served file.
2. **Generate derivatives at upload** in a background job: AVIF and WebP at
   widths such as 320, 640, 960, 1600 px, plus a tiny blur placeholder. Store
   width, height and placeholder on `product_images`. *Why:* the phone should
   download a ~40–120 KB image sized for its slot, the page should reserve space
   (no layout shift), and the work should happen once per upload rather than per
   first view.
3. **Strip metadata and enforce limits** (maximum megapixels, colour profile
   normalised to sRGB). *Why:* EXIF can carry location; decompression bombs pass
   a byte-size check.
4. **Serve from object storage behind a CDN** with immutable URLs (already UUID
   names). Retire the `local` provider outside development. *Why:* serverless has
   no disk, and route-handler file serving costs a function invocation per image.
5. **Use `next/image` with a custom loader** pointing at the stored derivatives
   (or the CDN's transform URL) and correct `sizes` — already present in
   `MediaImage`. Mark exactly one LCP image per page `priority`. Constrain
   `images.deviceSizes`/`imageSizes` to the sizes actually generated.
6. **Clean up orphans** in a job: files no longer referenced by
   `product_images`, `variant_images`, campaign settings or order snapshots.
7. **Budget**: product-card image ≤ 60 KB and product-hero image ≤ 150 KB at
   390 px CSS width; asserted in the performance suite.

## 19. Recommended database optimisation strategy

1. **Fix lock ordering**: lock all cart variants in one statement ordered by id
   (`select … from product_variants where id = any($1) order by id for update`)
   before reserving. *Why:* removes the measured deadlocks; one round trip instead
   of one per line.
2. **Catch the idempotency race**: on unique violation of
   `orders_idempotency_key_unique`, read and return the existing order. *Why:*
   measured 9/10 error responses for a double tap.
3. **Expire unpaid orders**: a job releases capacity and cancels `placed` orders
   past a configurable window (record as a decision; the business must choose the
   window). *Why:* capacity must reflect money committed.
4. **Listing read model**: a `product_listing` table (or columns on `products`)
   with `min_price_bdt`, `list_price_bdt`, `discount_percent`, `units_sold`,
   `rating_avg`, `review_count`, `buyable_now`, `closes_at`, maintained when
   variants, orders or reviews change (trigger or job). Index the sort columns.
   *Why:* turns S4's per-row subqueries into index scans and makes facet counts
   cheaper.
5. **Indexes** (verify each with `EXPLAIN ANALYZE` on the scale database):
   `orders (placed_at desc)`, `orders (status, placed_at desc)`,
   trigram indexes on `users.email`, `orders.order_number`, `orders.guest_email`
   for admin search, `cart_items (variant_id)`, `sessions (expires_at)`,
   *Why:* the measured admin order list and search paths
   scan and sort 100,000 rows.
6. **Keyset pagination** for admin orders, audit log and customers. *Why:*
   offset cost grows with page number (measured 278 → 369 ms).
7. **Server-side pagination and filtering** for the admin product list. *Why:*
   loading 5,000 rows per view does not scale to "powerful admin".
8. **Streamed CSV exports** (cursor + `ReadableStream`), or generated by a job and
   downloaded when ready. *Why:* measured 8 MB in memory at 100k orders.
9. **Batch search reindexing** for bulk operations (queue in the transaction,
   rebuild in the job) while keeping single edits synchronous. *Why:* measured
   ~60 s of in-transaction indexing for a 5,000-product import.
10. **Migration ledger** (§17) before any of the schema changes above ship.
11. **Payment row in the order transaction** as `initiated` with the provider call
    made after commit and its reference written back; reconcile failures in a
    job. *Why:* closes X2.
12. **Operational hygiene**: `pg_stat_statements` on the hosted database,
    autovacuum thresholds reviewed for `rate_limit_hits`, `sessions`,
    `search_queries`, `notifications`; point-in-time recovery confirmed.

## 20. Recommended caching strategy

| Data | Cache | Invalidation | Why |
| --- | --- | --- | --- |
| Category tree and per-category counts (header, every page) | `use cache`, long life | tag `catalog:categories`, `catalog:counts` on category/product publish changes | Read on every storefront request; changes only on staff edits |
| Product card data for listings | `use cache` per query key, minutes | tags `product:<id>`, `catalog:listing` | Measured 11–18 queries per page |
| Product detail (description, specs, images, variant matrix) | `use cache` per slug | tag `product:<id>` | Measured 444 KB/1.6 s for large variant pages |
| Buy box price, capacity, closing time | **not cached** — streamed in `<Suspense>` or fetched per request | — | Server truth where money is decided; `CLAUDE.md` §7 |
| Session, cart count, wishlist, recently viewed | per request, in `<Suspense>` | — | Per-user; must never cross users |
| Search results and facets for common queries | short `cacheLife` (seconds–minutes) keyed on normalised params | tag `catalog:listing` | Bursty repeated queries |
| Suggestions | existing `private, max-age=30`; add shared server cache for popular prefixes | tag `catalog:listing` | Keystroke traffic |
| Sitemap | cached, hourly | tag `catalog:listing` | 5,000+ URLs; crawlers |
| Media | immutable CDN caching (already UUID URLs) | never; new URL on change | — |
| Admin pages | not cached | — | Staff need live figures (`CLAUDE.md` §7) |

Rules: every admin mutation that changes customer-visible catalogue data calls
the matching `updateTag`/`revalidateTag` inside `lib/`, next to the audit write,
so invalidation cannot be forgotten by one route. Cached functions take ids and
normalised parameters only, never a session.

## 21. Recommended API/backend strategy

1. **Idempotent, lock-ordered checkout** (§19.1–19.3) and a `payments`
   record written atomically with the order.
2. **Real webhook shape before a real gateway**: a signed webhook endpoint per
   provider, idempotent on the provider's event id (store processed event ids),
   capture only inside the guarded transition, and a reconciliation job. Remove
   or guard `POST /api/checkout/confirm` so it cannot run in production. *Why:*
   X1/X3, and SSLCommerz/bKash/Nagad confirm asynchronously.
3. **Persist provider state in the database, not memory** (payment intents,
   shipment bookings). *Why:* multi-instance deployments lose it today.
4. **Courier abstraction extended** with webhooks/polling for tracking events
   into `order_status_history`, idempotent per carrier event. *Why:* future
   courier integrations without touching order logic.
5. **Job runner** (§17) owning: notification delivery with `SKIP LOCKED` claims,
   unpaid-order expiry, waitlist offers, search reindex batches, image
   derivatives, exports, SKU-hold expiry, pruning.
6. **Response contract**: map known database conflicts (unique, check,
   serialization, deadlock) to typed 409s with a retry hint; retry deadlock and
   serialization failures once inside `lib/` for checkout. *Why:* a shopper
   should never see a raw database error.
7. **Origin check** on cookie-authenticated mutations, and a production CSP
   without `'unsafe-inline'` scripts using nonces. *Why:* defence in depth (X4, X6).
8. **Observability**: structured logs with request id, Sentry or equivalent,
   timings for checkout and search. *Why:* nothing reports production errors now.

## 22. Recommended frontend/rendering strategy

1. **Adopt Cache Components route by route** (storefront layout → home →
   category/search → product → help/legal), keeping per-user parts in
   `<Suspense>`. *Why:* §20; measured per-request render cost.
2. **Trim client JavaScript to under the 200 KB budget on every storefront
   page**: move `PAYMENT_METHOD_LABELS` and other constants used by client
   components into client-safe modules with no `lib/env`/Zod/Node imports; audit
   each `"use client"` boundary with the bundle analyser; load framer-motion
   features lazily (`LazyMotion`) where used. *Why:* measured 194–238 KB gzip and
   a 220 KB-gzip Zod chunk on `/checkout`.
3. **Shrink RSC payloads for variant-heavy products**: send a compact variant
   matrix (ids, option indices, price, availability) and derive labels on the
   client, or load the full matrix on interaction. *Why:* measured 444 KB HTML
   for 250 variants.
4. **Mobile-first performance budgets** per page type: LCP < 2.5 s and
   INP < 200 ms on a mid-range Android over 4G, CLS < 0.1, JS ≤ 170 KB gzip,
   HTML ≤ 60 KB gzip. *Why:* most traffic is mobile (spec §6).
5. **Streaming and skeletons** already exist (`loading.tsx`); pair them with
   cached shells so the skeleton is rarely seen.
6. **Admin**: server-paginated tables with URL state, virtualised rows for large
   variant matrices, and background exports. *Why:* §19.6–19.8.

## 23. Recommended testing/load-testing strategy

1. **Commit the scale harness**: a `db/seed-scale.ts` that builds the synthetic
   dataset used here (parameterised: products, variants per product, customers,
   orders), never runnable against a non-scratch database. *Why:* every
   performance claim in later phases must be re-measurable.
2. **Concurrency tests on real Postgres** (existing pattern in
   `tests/preorder-concurrency.test.ts`): multi-line carts in opposite orders,
   same-key simultaneous submissions, confirm-payment replay, capacity release
   racing a reservation. Confirm each test fails before its fix. *Why:* the
   deadlock and the idempotency race escaped the current suites.
3. **Query-count and plan assertions** for the top paths (header, listing,
   product, checkout, admin orders): fail if query count rises or a sequential
   scan appears on a large table in the scale database. *Why:* fan-out is the
   measured bottleneck and regresses silently.
4. **Load tests** with k6 (or autocannon) against a production build and a
   Neon branch, scenarios: browse mix (home → category → product), search mix,
   preorder launch (N shoppers checking out one variant), admin pipeline. Record
   p50/p95/p99, error rate and database connections. *Why:* the §8.3 numbers are
   single-machine and must be repeated in the real topology.
5. **Performance budgets in CI**: bundle size per route, Lighthouse CI on mobile
   emulation for home, category, product, cart. *Why:* the product page's recorded
   JavaScript grew from 136 KB to 141 KB gzipped between two earlier passes, and
   this audit's whole-page measure puts every storefront page near or past the
   200 KB guideline; today the check only runs when someone runs the production
   e2e suite by hand.
6. **Migration tests on an existing database**: apply the previous release's
   schema and data, then the new migrations. *Why:* the deploy path is not the
   from-empty path tests use.
7. **CI pipeline**: typecheck, lint, unit, build on every push; targeted e2e by
   changed area; full e2e (production build) nightly.

## 24. Proposed implementation order

Each step is small enough to verify on its own, and ordered by the priority rule
in `CLAUDE.md` §10 (security → data integrity → business correctness → existing
functionality → UX → performance → polish).

| Step | Work | Why this position | Verification |
| --- | --- | --- | --- |
| 1 | **Measurement harness**: scale seed, benchmark and load scripts, concurrency tests that reproduce the deadlock and idempotency race | Every later step needs a before/after number; the failing tests prove the fixes | Tests fail on current code |
| 2 | **Checkout correctness**: ordered locking, unique-violation → existing order, payment row in transaction, typed conflict responses | Measured order failures under load | Step 1 tests pass; 40-way probe 40/40 |
| 3 | **Payment safety**: guard/remove `/api/checkout/confirm` in production, DB-persisted provider state, webhook skeleton with event idempotency | X1–X3 before any real gateway | Security specs; replay tests |
| 4 | **Migration ledger** and drizzle metadata repair | Needed before the schema changes in later steps | Apply on a copy of the current DB twice |
| 5 | **Job runner** + unpaid-order expiry (window recorded in DECISIONS) + notification claim/delivery | Capacity leak and message delays | Expiry releases capacity; no duplicate sends under concurrent drains |
| 6 | **Indexes, keyset pagination, admin server-side pagination, streamed exports** | Measured admin and export costs | Plans on scale DB; admin at 5k/100k |
| 7 | **Listing read model** for sort/filter aggregates | Measured 216–422 ms listing paths | Same results as today on scale DB; timing |
| 8 | **Cache Components adoption** with tag invalidation from `lib/` | Measured per-request render cost | c=20 throughput and p95 vs §8.3; invalidation tests |
| 9 | **Image pipeline**: derivatives, metadata strip, CDN serving, orphan clean-up | Heavy imagery at mobile sizes | Byte budgets per slot; LCP |
| 10 | **Client payload trimming** and variant-matrix payload | Measured JS and HTML over budget | Bundle budgets in CI |
| 11 | **Infrastructure**: pooled connections, observability, CI, staging on a Neon branch | Production readiness | Load test in real topology |
| 12 | **Real integrations**: SSLCommerz/bKash/Nagad, courier, email/SMS behind the existing interfaces | Out of MVP scope until credentials exist | Provider sandboxes |
| 13 | **Security hardening round two**: nonce CSP, Origin checks, doc corrections | Defence in depth | Security specs |
| 14 | **Full load test at target scale and regression sweep** | Proves the targets in this audit | k6 report; full e2e |

---

## Appendix A — how the measurements were taken

- **Gates**: `npx tsc --noEmit`, `npx eslint`, `npx vitest run`, `npx next build`
  from the repository root. End-to-end: `tsx e2e/prepare-db.ts` then Playwright
  with `E2E_PRODUCTION=1` against the build on port 3200, so the developer server
  on port 3000 kept running.
- **Scale database**: a separate database `audit_scale` created on the local
  development PostgreSQL server, migrated with `db/migrate.ts`, and filled by SQL
  `generate_series` inserts: 185 categories (5 → 30 → 150), 3 specifications per
  leaf, 5,000 products (5 % draft, ⅓ in stock, remainder preorder), 1–6 variants
  per product plus 250 on every thousandth product (18,731), one product-scoped
  "Colour" option per product, 5 images per product, 20,000 customers with an
  address, 100,000 orders over two years with 1–3 items, one status row and one
  payment each, 59,915 approved reviews, 50,000 audit rows. `ANALYZE` was run
  after loading. Search index rows were built by the application's own triggers.
- **Data-function timings**: a script importing the application's `lib/`
  functions directly, 5 warm runs each, median reported.
- **Query counts**: the same script counting calls on the postgres-js client.
- **Concurrency probes** (scratch database only): 40 two-line carts, alternating
  item order, placed concurrently with `DATABASE_POOL_MAX=20`; 10 concurrent
  `placeOrder` calls sharing one cart and idempotency key.
- **HTTP**: `next start -p 3100` with `DATABASE_URL` pointing at `audit_scale`;
  each path warmed once, 10 serial requests, then 20 concurrent clients × 5
  requests. JavaScript weight is the sum of `<script src>` files in the HTML,
  gzipped with Node's `zlib` default level.
- **Limits**: one Windows machine, database on the same host, one Node process,
  no CDN, no TLS. The scale data is synthetic; its distribution (for example
  every order being 1–3 items) is a stand-in, not a forecast.
