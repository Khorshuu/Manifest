# Progress

Legend: `[ ]` not started · `[~]` in progress · `[x]` done and verified · `[!]` blocked/unverified, with reason.

## Baseline (first session)

- `[x]` Repository audit — repo was empty of application code (no `.git`, no `package.json`); a leftover unrelated `my-site/` Vite scaffold was found and removed. No build/lint/test baseline existed at audit time, because no project was scaffolded yet; the baseline was established at the end of Phase 1 and is recorded below.
- `[x]` Read and reconciled `MASTER_PRODUCT_SPEC.md` and `DESIGN_GUIDELINES.md`.
- `[x]` Proposed tech stack, recorded with reasoning in `DECISIONS.md`.
- `[x]` Proposed database schema, recorded in `DATABASE.md`.
- `[x]` Living docs established: `ARCHITECTURE.md`, `DATABASE.md`, `BUSINESS_LOGIC.md`, `SECURITY.md`, `DECISIONS.md`, `TESTING.md`, this file.
- `[x]` Stack and schema confirmed by the product owner; go-ahead given for Phase 1.

## Phase sequence (CLAUDE.md §6)

- `[x]` **Phase 1 — Project scaffold & architecture.** Next.js 16 (App Router) + TypeScript strict, Tailwind v4 with the Import Manifest tokens in `app/globals.css`, Fraunces + Inter, Drizzle + postgres-js connection in `db/index.ts`, Zod-validated env in `lib/env.ts`, Vitest and Playwright configured, `CLAUDE.md` folder layout created. Verified — see baseline below.
- `[x]` **Phase 2 — Database.** 26 Drizzle tables in `db/schema/` matching `DATABASE.md`, first migration at `db/migrations/0000_initial_schema.sql`, and a re-runnable seed in `db/seed.ts`. Verified — see Phase 2 baseline below.
- `[x]` **Phase 3 — Auth & admin shell.** argon2id passwords, database-backed sessions keyed by a token hash, the three role gates in `lib/auth/authorize.ts`, login/logout/register routes with rate limiting, the `/admin` shell with server-side role enforcement, and a dashboard whose every figure is a live query. Verified — see Phase 3 baseline below.
- `[~]` **Phase 4 — Product system.** Category tree with cycle protection, attribute and value management, product create/update/archive/restore with slug derivation, an admin catalog UI, and admin API routes. Image upload is not built yet and carries into the next slice of this phase.
- `[x]` **Phase 5 — Variation engine.** Cartesian combination generation with a 500-variant guard, idempotent regeneration that never disturbs existing variants, per-combination enable/disable, bulk edit, and the admin variant matrix. Verified — see Phase 5 baseline below.
- `[~]` **Phase 6 — Inventory & preorder engine.** Locked-transaction capacity reservation and release, availability evaluation, waitlist, and the preorder window lifecycle (open, close, extend). Verified — see Phase 6 baseline below. Admin UI for the window controls is carried forward.
- `[~]` **Phase 7 — Storefront.** Home page with the Import Manifest signature patterns, category listings with subtree inclusion and sorting, product detail with variant selection and the landed-price panel, search, and related products. Verified — see Phase 7 baseline below. Faceted filtering and the reviews UI are carried forward.
- `[x]` **Phase 8 — Cart & checkout.** Cart persisted by cookie or account with guest-cart merge on login, live-priced totals, a checkout that computes every amount server-side, idempotent order placement, the mock payment provider, order confirmation, and guest order tracking. Verified — see Phase 8 baseline below.
- `[x]` **Phase 9 — Orders.** Customer order history and tracking, shopper self-cancellation while nothing has been sourced, the admin order pipeline with filters, forward-only status transitions, and refunds through the payment provider. Verified — see Phase 9 baseline below.
- `[x]` **Phase 10 — Shipping.** Shipping provider interface with an idempotent mock, shipment booking, manual tracking references, staff-only internal notes, and the tracking reference surfaced to shoppers. Verified — see Phase 10 baseline below.
- `[x]` **Phase 11 — Admin ops.** Live dashboard metrics with capacity alerts and top products, staff and role management, three CSV exports, and the audit log viewer with filtering. Verified — see Phase 11 baseline below.
- `[x]` **Phase 12 — Analytics.** Purchase funnel with per-step conversion, revenue by day, preorder capacity utilisation, order stage breakdown, and new customer counts — all from recorded data, with the gaps named. Verified — see Phase 12 baseline below.
- `[~]` **Phase 13 — SEO/performance.** Product, breadcrumb and organisation structured data generated from the values the page renders, canonical metadata, a sitemap that excludes private pages, robots.txt, and budget checks. The production JavaScript budget is unverified — see Phase 13 baseline below.
- `[x]` **Phase 14 — Security hardening.** Security headers, customer anonymisation for deletion requests, and a pass over every rule in SECURITY.md written as probes that try to break it. Verified — see Phase 14 baseline below.
- `[x]` **Phase 15 — Full QA.** Every acceptance criterion in MASTER_PRODUCT_SPEC.md section 7 checked end to end, the suite run against a production build as well as the dev server, and the production JavaScript budget measured. Verified — see Phase 15 baseline below.

Each phase stops for explicit go-ahead before the next begins, per CLAUDE.md §6. Phases 8 to 15 were run consecutively at the product owner's explicit instruction.

## Verification baseline (end of Phase 1)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes — Next.js 16.3.4, `/` and `/_not-found` prerendered static |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 2 files, 4 tests (`tests/money.test.ts`, `tests/env.test.ts`) |
| `npm run test:e2e` | `[x]` passes — 2 tests, mobile (Pixel 7) and desktop projects |
| Dev server UI inspection | `[x]` done — status page rendered and viewed at 375px and 1440px; Fraunces display face, Inter body, brass/transit-green/blue-300 badge borders all resolving from tokens, no horizontal overflow at 375px |

Known non-blocking warnings: Vitest reports that `vitest.config.ts` is loaded as CommonJS, and that `vite-tsconfig-paths` is now redundant with Vite's native `resolve.tsconfigPaths`. Neither affects results; both are left as-is rather than adding `"type": "module"`, which would need re-verification of the Next.js build for no current benefit.

## Verification baseline (end of Phase 2)

No PostgreSQL server, Docker, or psql exists on this machine, so `npm run db:migrate` and `npm run db:seed` could not be run against a real server. Rather than leave the migration unverified, the test suite applies the checked-in migration to an in-process Postgres (PGlite) and runs the real seed against it, so both are exercised on every test run.

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 18 tests, 4 files |
| Migration applies | `[x]` verified against PGlite: all 26 tables created, every check constraint enforced (capacity ceiling, non-negative reserved, deposit-requires-percent, role, order status, review rating) |
| Seed applies | `[x]` verified against PGlite: 3 users one per role, 3-level category tree, argon2-hashed passwords, one variant deliberately at full capacity, re-runnable without duplicates |
| `npm run db:migrate` against a real server | `[!]` UNVERIFIED — no PostgreSQL available on this machine. Needs a local Postgres or a Neon branch in `DATABASE_URL`. |
| `npm run db:seed` against a real server | `[!]` UNVERIFIED — same reason. |

## Verification baseline (end of Phase 3)

A real PostgreSQL 18.4 now runs locally through `npm run db:server` (binaries shipped by `embedded-postgres`, no system install and no admin rights), so the browser tests exercise the actual database. Unit and integration tests continue to use in-process PGlite, which is faster and needs no server.

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 61 tests, 10 files |
| `npm run test:e2e` | `[x]` passes — 18 tests, mobile and desktop |
| `npm run db:migrate`-equivalent against a real server | `[x]` `npm run db:setup` applies both migrations and the seed to real PostgreSQL |
| Admin gate | `[x]` verified in a browser: anonymous is redirected to sign in, a customer is redirected away from `/admin`, a staff admin sees no Staff/Settings links and no financial totals, a super admin sees both |
| Dashboard figures | `[x]` verified against seeded data — counts come from live queries, nothing hardcoded |

Two defects were found and fixed during this phase: `sessions.id` was declared `uuid` but holds a SHA-256 token hash (fixed by migration `0001`), and the login rate limit was low enough that a shared IP would lock out legitimate users (now a high per-IP ceiling with a strict per-account limit).

## Verification baseline (end of Phase 4, first slice)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 94 tests, 12 files |
| `npm run test:e2e` | `[x]` passes — 32 tests, mobile and desktop |
| Customer cannot create a listing | `[x]` verified three ways: calling `createProduct` directly with a customer session, posting at `/api/admin/products` as a signed-in customer (403), and as an anonymous visitor (401) |
| Category tree | `[x]` three levels rendered and verified in a browser; cycles refused; a category with children or products cannot be removed |
| Audit trail | `[x]` product creation and archiving write `audit_log` rows with actor and before/after values, in the same transaction |

Not done in this slice, carried forward:

- `[ ]` Product image upload (the storage decision in DECISIONS.md D-001 names Cloudflare R2; nothing is wired yet).
- `[ ]` Editing an existing product from the admin UI — the API and `lib/` function exist and are tested, but there is no edit form.
- `[ ]` The step wizard described in MASTER_PRODUCT_SPEC.md section 4; the current form is a single page.

## Verification baseline (end of Phase 5)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 134 tests, 14 files |
| `npm run test:e2e` | `[x]` passes — 42 tests, mobile and desktop |
| Regeneration is non-destructive | `[x]` verified: a variant carrying a changed price, capacity, and reserved slots survives a regeneration untouched; dropping an attribute reports the old variants as orphaned and keeps them |
| Capacity floor | `[x]` verified: capacity cannot be set below reserved slots, and the attempt leaves the old value in place |
| Bulk edit auditing | `[x]` verified: a bulk price change writes one audit row per variant, not one per batch |

A real performance defect was found and fixed here. `generateVariants` queried the base database handle for SKU uniqueness while its own transaction was open; on a single-connection database that serialises against the transaction, taking the suite from 3 seconds to over 197. SKU allocation now runs on the open transaction against one read of the SKUs in use.

## Verification baseline (end of Phase 6)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 173 tests, 16 files (1 skipped only when no PostgreSQL server is running) |
| No overselling under real concurrency | `[x]` verified against real PostgreSQL: 20 shoppers racing for one slot yields exactly one order; 40 attempts against capacity 5 yield exactly 5 |
| Reservation is atomic with its order | `[x]` verified: when the surrounding transaction fails, the slot is not held |
| Release is safe | `[x]` verified: a double release cannot drive the reserved count below zero |

### What the row lock actually buys, measured

The concurrency suite was initially passing even with `for update` removed, which made it worthless. Two causes were found and fixed:

1. The connection pool was created lazily, so the first reservation committed while the others were still doing TCP setup. The suite now warms every connection before racing.
2. Even then, the read-to-write window in the real code is narrow enough that the race rarely lands.

An isolated experiment settled what the lock does. Removing it and running 30 rounds of 30 concurrent reservations against capacity 1 produced **841 database check-constraint rejections**; with the lock, zero. The reserved count never exceeded capacity either way, because the `product_variants_reserved_within_capacity_check` constraint is a genuine second line of defence — but without the lock, shoppers receive a raw integrity error instead of "that preorder is full".

The suite now asserts the *shape* of every refusal, not just the count, and has been confirmed to fail when the lock is removed.

Carried forward from this phase:

- `[ ]` Admin UI for opening, closing, and extending a preorder window (the `lib/preorder` functions exist and are tested; there is no form yet).
- `[ ]` Notifying the waitlist when capacity frees up — still an open question in DATABASE.md (automatic re-offer vs manual).

## Verification baseline (end of Phase 7)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 173 tests, 16 files |
| `npm run test:e2e` | `[x]` passes — 72 tests, mobile and desktop |
| UI inspected | `[x]` home page and product page viewed at 375px and 1440px against seeded data |
| No sideways scroll at 320px | `[x]` asserted in the smoke suite, not only eyeballed |
| Sourcing cost never reaches the storefront | `[x]` asserted against the rendered HTML |

### A bug every green test had missed

The product card aggregates — photo, price, rating — were written as correlated subqueries inside the product select. Drizzle drops the table qualifier on a column whose table is not part of the outer query, so `product_images.product_id = products.id` rendered as `"product_id" = "id"`: a comparison of two columns of the same table, always false. Every card silently showed "No photo yet" and no rating, and nothing failed, because no test asserted that the data arrived.

Found by looking at the page. Fixed by fetching the aggregates in a small fixed number of keyed queries (`lib/catalog/card-data.ts`), and two regression tests now assert that a card carries its photograph and a real price.

### Test data no longer pollutes development

The end-to-end suite was writing into the development database, so the local catalog filled with "Test Product" rows and the storefront became impossible to review. `npm run test:e2e` now creates and seeds a dedicated `preorder_e2e` database first.

Carried forward from this phase:

- `[ ]` Faceted filtering by price, brand, and attribute (sorting is done; facets are not).
- `[ ]` The reviews list and rating distribution on the product page — the data model and aggregates exist, the UI does not.
- `[ ]` Search autosuggest and suggested corrections on a miss. Fuzzy matching is deferred by MASTER_PRODUCT_SPEC.md section 7, but the suggestion behaviour it does ask for is not built.
- `[ ]` `next/image` for product media once the storage integration lands. Plain image tags with explicit dimensions are used meanwhile.

## Verification baseline (end of Phase 8)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 201 tests, 17 files |
| `npm run test:e2e` | `[x]` passes — 92 tests, mobile and desktop |
| Guest completes a purchase | `[x]` verified in a browser, end to end, including the confirmation page and the order number |
| Duplicate submission | `[x]` verified: replaying the exact checkout payload returns the original order, and neither a second order nor a second payment row is created |
| Server prices the order | `[x]` verified two ways: the checkout request body carries only `address`, `email`, `idempotencyKey` and `method`, and a request carrying a `totalBdt` is rejected outright |
| Capacity is atomic with the order | `[x]` verified: when placement fails partway, no slot stays reserved and no order exists |
| Cash on delivery on a preorder | `[x]` refused, and the option is not offered |
| Guest order lookup | `[x]` needs the order number *and* the email; the number alone finds nothing |

### A schema gap the spec had already ruled on

`addresses.user_id` was `not null`, which makes guest checkout impossible — but MASTER_PRODUCT_SPEC.md section 5.5 says guests complete checkout without an account. Fixed by migration `0002_guest_addresses`, which drops the constraint. A guest address is stored with no owner; when the shopper is signed in it is attached to their account so it can be reused.

Carried forward from this phase:

- `[ ]` The balance payment for a deposit order. `DATABASE.md` still records the open question of whether it is triggered automatically or by staff, so only the deposit is taken at placement today.
- `[ ]` Shipping fees and customs duty as separate computed lines. Both are currently folded into the variant price, which matches the "one landed price" promise but leaves `orders.shipping_fee_bdt` always zero.
- `[ ]` Confirmation email and SMS. The notification provider interface is declared but has no implementation, so nothing is sent.
- `[ ]` A real payment gateway. The mock provider is idempotent and can be made to decline, and SSLCommerz slots in behind the same interface.

## Verification baseline (end of Phase 9)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 226 tests, 18 files |
| `npm run test:e2e` | `[x]` passes — 110 tests, mobile and desktop |
| Status never moves backward | `[x]` verified at the API with a hand-crafted request, not only by the UI withholding the button |
| Cancelling returns capacity only while it is still held | `[x]` verified: cancelling before sourcing frees the slots; cancelling after keeps them consumed, because the item has been bought in the US |
| A refund is a payment row | `[x]` verified: refunding writes a negative refund row, the order's own totals do not move, and the payment rows net to zero |
| A customer cannot advance or refund | `[x]` verified at the API for both actions |

Two defects were found while verifying:

- A malformed order id reached the database and produced a 500. The route now validates the id and answers 400.
- The end-to-end tests shared one customer account, and a signed-in account has one cart, so parallel tests were emptying each other's carts. Each test now registers its own account.

Carried forward from this phase:

- `[ ]` Order status change notifications. The notification provider interface exists but has no implementation, so a shopper is not told when their order moves.
- `[ ]` Partial refunds. A refund currently returns the full captured amount.
- `[ ]` The balance payment for deposit orders, still blocked on the open question in DATABASE.md.

## Verification baseline (end of Phase 10)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 240 tests, 19 files |
| `npm run test:e2e` | `[x]` passes — 120 tests, mobile and desktop |
| Booking is idempotent per order | `[x]` verified: booking twice returns the same reference and books no second delivery |
| Internal notes never reach a customer | `[x]` verified against the whole rendered guest lookup page, not a particular element |
| A customer cannot set tracking or add notes | `[x]` verified at the API for both |

### A leak found by a test that was written to fail

The guest order lookup returned the whole `orders` row, which includes `internal_notes`. Staff notes were reaching customers. The customer-facing loader now selects its columns explicitly and omits the field, and the staff loader is a separate function rather than a flag — the same shape used for the catalog queries, so a missed conditional cannot leak.

Two smaller defects were fixed alongside it:

- The shipping panel kept showing the value it first mounted with, so booking a delivery appeared to return nothing. The page now remounts it on a key derived from the tracking reference.
- Two controls on the admin order page were both labelled "Internal note". Renamed so each says what it actually does.

Carried forward from this phase:

- `[ ]` A real courier integration. `SHIPPING_PROVIDER=courier` raises rather than pretending, and the mock is idempotent and returns checkpoints.
- `[ ]` Surfacing carrier checkpoints on the customer tracking page. `trackOrder` returns them; the page shows only the reference.
- `[ ]` Shipping fees as a computed line. They remain folded into the landed price, so `orders.shipping_fee_bdt` is always zero.

## Verification baseline (end of Phase 11)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 273 tests, 20 files |
| `npm run test:e2e` | `[x]` passes — 144 tests, mobile and desktop |
| Only a super admin manages staff | `[x]` verified: a staff admin is refused in lib/, redirected in the UI, and refused at the API |
| Only a super admin sees money | `[x]` verified: no revenue tile, no margin export link, and a 403 from the export endpoint |
| The site cannot be left without a super admin | `[x]` verified: demoting the last one is refused |
| A role change bites immediately | `[x]` verified: every session belonging to the account is dropped |
| Dashboard figures are live | `[x]` verified: revenue counts only collected money and excludes refunds |
| CSV exports cannot carry a formula | `[x]` verified for =, +, - and @ |

### A responsive defect the mobile project caught

A scrollable table inside a grid column overflowed its track, because a grid item defaults to `min-width: auto`. On a narrow screen the table pushed past its column and a label from the next section covered the submit button, making it unclickable. Fixed with `min-w-0` on the grid children, applied to the cart, checkout, admin order, and staff pages, which all share the shape.

This is exactly what running the suite on a phone viewport is for — every desktop run passed.

Carried forward from this phase:

- `[ ]` The product management step wizard from MASTER_PRODUCT_SPEC.md section 4. The current form is a single page.
- `[ ]` Customer management beyond the list: no detail view, and no anonymisation flow for a deletion request.
- `[ ]` Analytics beyond the dashboard — the funnel reporting in Phase 12.

## Verification baseline (end of Phase 12)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 292 tests, 21 files |
| `npm run test:e2e` | `[x]` passes — 158 tests, mobile and desktop |
| Revenue counts only money collected | `[x]` verified: an unpaid order contributes nothing, and a refunded order drops back out |
| Revenue stays behind the super-admin gate | `[x]` verified in lib/ and in the browser — a staff admin sees the funnel and no revenue section at all |
| No division by zero on an empty period | `[x]` verified for both the funnel and preorder utilisation |

### Reporting says what it cannot measure

Nothing records product views or individual add-to-cart attempts, so the funnel starts at carts created rather than at the top. Rather than approximating, `getFunnel` returns a `missing` list and the page renders it under "Not measured yet". A partial funnel presented as complete would be the kind of plausible-looking number CLAUDE.md section 7 rules out.

Charts are plain bordered bars rather than a charting library: the design system prefers borders to decoration, and one fewer dependency is worth more here than a rendered axis.

Carried forward from this phase:

- `[ ]` Product view and add-to-cart events, which would complete the funnel.
- `[ ]` Cohort and repeat-purchase reporting. Nothing in the data model prevents it; it is simply not built.

## Verification baseline (end of Phase 13)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 304 tests, 22 files |
| `npm run test:e2e` | `[x]` passes — 178 tests, mobile and desktop |
| Structured data agrees with the page | `[x]` verified: the price in the JSON-LD is compared against the price rendered on the product page |
| Preorder availability is honest | `[x]` verified: PreOrder rather than InStock, and SoldOut when nothing can be bought |
| No invented ratings | `[x]` verified: `aggregateRating` is omitted entirely when there are no approved reviews |
| Sitemap excludes private pages | `[x]` verified for /admin, /account, /cart and /checkout |
| robots.txt disallows the private areas | `[x]` verified, and it points at the sitemap |
| Server-rendered without JavaScript | `[x]` verified with scripting disabled — what a crawler and a slow connection see |
| No unsized images | `[x]` verified: every image either carries width and height or sits in an aspect-ratio box |

### On the JavaScript budget

DESIGN_GUIDELINES.md sets 200KB gzipped on a product page. The end-to-end suite runs against `next dev`, which serves unminified, uncompressed modules, so measuring the guideline figure there would be meaningless. The test measures the uncompressed development payload against a deliberately generous ceiling instead — enough to catch a dependency that balloons the bundle, and honest about not being the production number.

Measuring the real figure needs the suite pointed at `next build && next start`, which is recorded below as carried forward rather than claimed.

Carried forward from this phase:

- `[!]` The production JavaScript budget is UNVERIFIED. It needs an end-to-end run against a production build, not the dev server.
- `[ ]` Open Graph and Twitter card images. Declaring a card without the asset is worse than omitting it, so neither is declared.
- `[ ]` Largest contentful paint and interaction-to-next-paint against the guideline thresholds. These need a production build and a throttled profile.

## Verification baseline (end of Phase 14)

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 326 tests, 23 files |
| `npm run test:e2e` | `[x]` passes — 200 tests, mobile and desktop |

Each rule in SECURITY.md was checked by attempting to break it, not by reading the code:

| Rule | How it was probed |
| --- | --- |
| Security headers | `[x]` read off a live response: CSP with `frame-ancestors 'none'`, nosniff, DENY, referrer policy, permissions policy. `X-Powered-By` is absent |
| Session cookie | `[x]` confirmed HTTP-only and SameSite=Lax from the browser, and invisible to `document.cookie` |
| Sessions are not replayable | `[x]` the stored value is a SHA-256, never the token itself |
| Sign-out is server-side | `[x]` an admin page is unreachable immediately afterwards |
| Customer cannot reach staff capability | `[x]` refused at four admin endpoints, and refused in `lib/` when called directly |
| Anonymous is 401, not 403 | `[x]` verified — the two answers mean different things |
| Unknown fields rejected | `[x]` a request carrying an extra field is refused with 400, including a registration trying to set its own role |
| Login does not reveal account existence | `[x]` identical status and message for a known and an unknown email |
| Sourcing cost never reaches a shopper | `[x]` asserted against the rendered HTML of four storefront pages, and against both public queries |
| Guest order lookup | `[x]` the order number alone reveals nothing, and internal notes are absent |
| Audit log is append-only | `[x]` no update or delete function exists, and every entry carries an actor |
| Database backstops the application | `[x]` a direct write beyond capacity, or with an invalid role, is refused by a check constraint |
| Queries are parameterised | `[x]` a value containing SQL is stored as data; the users table survives |

### Added in this phase

- Security headers at the framework level, with a Content-Security-Policy that allows scripts and connections only from this origin. `unsafe-eval` is granted in development only, for fast refresh.
- `anonymiseCustomer`, for a deletion request: personal fields on the account, its addresses, and the guest contact details on its orders are replaced, while the orders and payments themselves are kept. Deleting them would break tax obligations and corrupt every revenue figure already reported.

Carried forward from this phase:

- `[ ]` Two-factor authentication for admin roles. SECURITY.md records this as recommended and unconfirmed; it is still unconfirmed.
- `[ ]` The data retention period under Bangladeshi law, which sets how long anonymisation can be deferred.
- `[ ]` A shared rate-limit store. The current limiter is process-local, which is a real limit on one instance and a speed bump on several.
- `[ ]` Upload validation. No upload endpoint exists yet, so the rules in SECURITY.md have nothing to apply to.

## Verification baseline (end of Phase 15 — full QA)

Run against **both** the dev server and a production build (`npm run test:e2e:prod`).

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 326 tests, 23 files |
| `npm run test:e2e` | `[x]` passes — 216 tests, mobile and desktop |
| `npm run test:e2e:prod` | `[x]` passes — the same 216 against a production build |

### The production JavaScript budget, now measured

DESIGN_GUIDELINES.md sets 200KB gzipped on a product detail page. Measured against a production build of `/products/seasonal-candy-variety-box`:

- **456.9 KB raw, 136.1 KB gzipped** — inside the budget, with room to spare.

This closes the `[!]` recorded at the end of Phase 13. The suite now asserts it on every production run, so a dependency that pushes past the budget fails the build rather than being noticed later.

### Acceptance criteria from MASTER_PRODUCT_SPEC.md section 7

| # | Criterion | Result |
| --- | --- | --- |
| 1 | A shopper preorders, pays by mobile wallet, and gets a confirmation stating the delivery window | `[x]` `e2e/acceptance.spec.ts` |
| 2 | A registered shopper completes a purchase with a saved address, and it appears in their history | `[x]` `e2e/orders.spec.ts` |
| 3 | A duplicate submission with the same idempotency key creates one order and one charge | `[x]` `e2e/acceptance.spec.ts` and `tests/checkout.test.ts` |
| 4 | A price change between cart and checkout is surfaced before payment | `[x]` the cart always shows the live price, and a changed line blocks checkout with a reason |
| 5 | Staff advance an order through every stage | `[x]` `e2e/acceptance.spec.ts` walks all six transitions |
| 6 | Cancelling before purchase refunds automatically without per-order work | `[~]` per-order cancellation and refund are verified; there is no batch entity to cancel, per DECISIONS.md D-005 |
| 7 | A shopper cancels before sourcing and is refunded; after sourcing it follows the staff policy | `[x]` `e2e/acceptance.spec.ts` |
| 8 | Search, browse, cart and checkout pass an accessibility audit at AA | `[~]` the structural rules are asserted — one h1 per page, every control labelled, a visible focus ring, and the buy action reachable by keyboard. A full axe audit is not run |

### Concurrency, re-confirmed

The no-overselling suite still fails when `for update` is removed, so it continues to test what it claims. See the Phase 6 baseline for the measurement.

### What is not done

Carried forward, and honest about it:

- `[ ]` Product image upload. No storage is wired, so `lib/providers` has no media provider and the admin cannot add a photograph; the seed ships placeholder art.
- `[ ]` The product edit form and the step wizard from MASTER_PRODUCT_SPEC.md section 4. Creation, archiving and the variation matrix exist; editing an existing product is API-only.
- `[ ]` Faceted filtering, the reviews UI, and search autosuggest.
- `[ ]` Notifications. The provider interface is declared but has no implementation, so no email or SMS is ever sent — including the order confirmation the spec asks for.
- `[ ]` The balance payment for deposit orders, still blocked on the open question in DATABASE.md.
- `[ ]` Shipping fees and duty as separate computed lines. Both are folded into the landed price, which matches the promise made to shoppers but leaves `orders.shipping_fee_bdt` always zero.
- `[ ]` A real payment gateway and a real courier. Both sit behind interfaces with working mocks.
- `[ ]` A full axe accessibility audit, two-factor authentication for admins, and a shared rate-limit store.

## Open items carried from other docs

- `MASTER_PRODUCT_SPEC.md` open questions: minimum batch/order economics, exact refund policy detail, exact deposit/balance trigger.
- `SECURITY.md` open questions: 2FA for admin roles, data-retention period under Bangladeshi law.
- `DATABASE.md` open questions: whether balance payment is auto-triggered or staff-triggered; automatic waitlist re-offer vs manual.

These don't block Phase 1 (scaffold has no dependency on their answers) but should be resolved before Phase 6 (preorder engine) and Phase 8 (checkout) reach them.
