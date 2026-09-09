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
- `[x]` Editing an existing product from the admin UI — done after Phase 15; see the product editing baseline near the end of this file.
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
| 8 | Search, browse, cart and checkout pass an accessibility audit at AA | `[x]` the real axe rule set (wcag2a, wcag2aa, wcag21a, wcag21aa) runs over twelve pages in `e2e/accessibility.spec.ts`, mobile and desktop, and passes with zero violations. It found eleven pages failing on contrast the hand-written checks had missed; the palette was fixed rather than the test loosened |

### Concurrency, re-confirmed

The no-overselling suite still fails when `for update` is removed, so it continues to test what it claims. See the Phase 6 baseline for the measurement.

### What is not done

Carried forward, and honest about it:

- `[x]` Product image upload — done after Phase 15. A media provider interface with a local implementation that writes to disk, byte-level format sniffing, generated filenames, and gallery ordering. See the media baseline below.
- `[x]` The product edit form — done after Phase 15. See the product editing baseline below.
- `[x]` The step wizard from MASTER_PRODUCT_SPEC.md section 4 — done after Phase 15; see the baseline below.
- `[x]` The reviews UI — done after Phase 15. Writing, moderation, and display; see the reviews baseline below.
- `[x]` Faceted filtering and search autosuggest — done after Phase 15; see the baseline below.
- `[~]` Notifications. The outbox, the templates, and the admin screen exist and are tested — see the notifications baseline below. No email or SMS provider is connected, so nothing reaches a customer yet; the mock provider records the attempt and the admin screen says so on the page.
- `[ ]` The balance payment for deposit orders, still blocked on the open question in DATABASE.md.
- `[x]` Shipping fees and duty as separate computed lines — done after Phase 15; see the baseline below.
- `[ ]` A real payment gateway and a real courier. Both sit behind interfaces with working mocks.
- `[x]` A full axe accessibility audit — done after Phase 15; see the baseline below.
- `[x]` A shared rate-limit store — done after Phase 15; see the baseline below.
- `[x]` Two-factor authentication — done after Phase 15; see the baseline below. It stays optional and recommended: making it compulsory for admins was considered and decided against, because it would mean an admin who loses both phone and recovery codes needs database access to recover.

## Product media (added after Phase 15)

| Gate | Result |
| --- | --- |
| `npm test` | `[x]` passes — 346 tests, 24 files |
| `npm run test:e2e` | `[x]` passes — 228 tests, mobile and desktop |
| Only staff may upload | `[x]` verified in `lib/` and at the API, for upload and removal |
| Format decided by the bytes | `[x]` verified: a shell script labelled `image/png` is refused, as is a file whose bytes contradict its declared type |
| Filenames are generated | `[x]` verified: a name containing `../` and a double extension is discarded entirely |
| Alternative text is required | `[x]` verified — an image nobody can hear described is not usable |
| The file is actually served | `[x]` verified: the uploaded URL returns an image from the site |

The local provider writes to `public/uploads`, which is real enough for development and for a single-server deployment. It is not suitable for a serverless host with no persistent disk — that is what the Cloudflare R2 implementation named in DECISIONS.md D-001 is for, and it slots in behind the same interface.

## Product editing (added after Phase 15)

A details form on the admin product page, plus archive and restore controls beside it.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 345 passed, 1 skipped, 24 files |
| `npm run test:e2e` | `[x]` passes — 238 tests, mobile and desktop |
| An edit survives a reload | `[x]` verified: the values are read back from the server, not from the optimistic message |
| Only staff may edit or archive | `[x]` verified at the API — a signed-in customer gets 403 from both `PATCH` and the archive `POST` |
| A malformed product id is refused | `[x]` verified — 400, not a 500 from the database |
| Archiving asks first, and does not delete | `[x]` verified: the confirmation is a second click, and the row is still in the listing afterwards |
| Restoring returns the product as a draft | `[x]` verified — nothing goes back on sale without someone choosing it |

Two things worth recording, because both were found rather than foreseen:

- `updateProduct` writes every column, so a field the form does not edit — `specTable`, `tags` — would be nulled on every save. The form carries those values back unchanged.
- The inputs are uncontrolled, so archiving updated the server data without changing what the status select displayed. The form is keyed on `updatedAt` and remounts. The e2e test for this was confirmed to fail when the key is removed.

## Order notifications (added after Phase 15)

A transactional outbox (DECISIONS.md D-009), messages for every order status, and a staff screen at `/admin/notifications`.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm run build` | `[x]` passes |
| `npm test` | `[x]` passes — 361 passed, 1 skipped, 25 files |
| `npm run test:e2e` | `[x]` passes — 248 tests, mobile and desktop |
| A message exists only for a committed order | `[x]` the row is written inside the order transaction, verified through `placeOrder` rather than by calling the queue directly |
| A replayed webhook tells the customer once | `[x]` verified: three `confirmPayment` calls with the same reference produce one `order.payment_confirmed` row |
| Staff wording stays with staff | `[x]` verified: a refund with the reason "Supplier failed us; goodwill refund" produces a message containing neither word |
| A provider outage loses nothing | `[x]` verified: a throwing provider marks the row `failed` with the reason and does not fail the caller |
| Only staff can read or drain the outbox | `[x]` verified in `lib/` and at the API — 403 for a customer, 401 anonymous |
| Delivery is honest about itself | `[x]` the mock provider sends nothing, and the admin page says so above the list rather than implying customers were reached |

Not done: no real email or SMS provider. The outbox is now drained on a schedule as well as opportunistically — see the scheduled sweep baseline below.

## Reviews (added after Phase 15)

Writing a review on the product page, moderation at `/admin/reviews`, and the published list with its rating breakdown.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 382 passed, 1 skipped, 26 files |
| `npm run test:e2e` | `[x]` passes — 256 tests, mobile and desktop |
| Only a delivered order can produce a review | `[x]` verified through the real pipeline: an order walked to `delivered` can review; the same order mid-transit cannot, and a stranger cannot |
| Nothing is public before approval | `[x]` verified: a pending review is absent from the list and does not move the average; approving adds it, rejecting removes it again |
| The reviewer's email is never published | `[x]` verified: the published payload contains a first name and no address |
| Every decision is explainable | `[x]` verified: moderation writes an `audit_log` row carrying the status it replaced |
| Only staff moderate | `[x]` verified in `lib/` and at the API — 403 for a customer on the queue, the counts, and the decision endpoint |
| One review per person per product | `[x]` verified: a second attempt is refused, and the account page stops offering it |

Note on the e2e suite: three tests that walk a full checkout plus six status transitions now call `test.slow()`. They passed alone and failed only under the load of the whole suite, which is a timeout and not a defect — but leaving them to flake would have made the suite untrustworthy.

## Faceted filtering and autosuggest (added after Phase 15)

A filter panel on the category and search pages, and suggestions under the header search.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm run build` | `[x]` passes |
| `npm test` | `[x]` passes — 404 passed, 1 skipped, 27 files |
| `npm run test:e2e` | `[x]` passes — 274 tests, mobile and desktop |
| The count describes the listing | `[x]` verified across six filter combinations: `countProducts` and `listProductCards` agree exactly, because both build their WHERE from the same function |
| Values of one attribute widen, different attributes narrow | `[x]` verified: two colours return both products, a colour crossed with a size returns none |
| Facet counts are real | `[x]` verified: a product with two variants carrying the same value counts once, and an unticked value shows what it would add rather than zero |
| Filtering works without JavaScript | `[x]` the panel is a GET form; the filtered listing is a plain URL, verified by navigating straight to one |
| Filters survive sorting and pagination | `[x]` verified — the page links rebuild the whole query string rather than only `sort` and `page` |
| Autosuggest cannot leak a draft | `[x]` verified: a freshly created draft returns no suggestions to a signed-out visitor |
| Autosuggest is reachable by keyboard | `[x]` verified: arrow key then Enter navigates; it is a combobox with a listbox, not a div with a click handler |

One real defect fixed on the way: `countProducts` ignored the brand filter, so a filtered listing could claim more pages than it had. Both paths now go through `buildProductWhere`, and a test iterates filter combinations asserting the two agree.

## Product setup wizard (added after Phase 15)

Basic info → Images → Variations → Pricing and capacity → SEO → Publish, at `/admin/products/<id>/wizard`, with a publish gate that is enforced on the server.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm run build` | `[x]` passes |
| `npm test` | `[x]` passes — 420 passed, 1 skipped, 28 files |
| `npm run test:e2e` | `[x]` passes — 286 tests, mobile and desktop |
| A product walks from draft to live | `[x]` verified end to end in one test: basics, a real upload, variant generation, price and capacity, SEO, publish, then found on the storefront as a signed-out visitor |
| An unfinished product cannot be published | `[x]` verified twice — the button is disabled, and the API returns 409 with the reasons when called directly |
| The gate lives on the server | `[x]` `publishProduct` re-runs every required check itself, so a stale wizard page or a direct call cannot talk it into publishing |
| Publishing cannot set an arbitrary status | `[x]` verified: publishing as `draft` is refused |
| Every step stays reachable | `[x]` verified: jumping straight to the last step works, and an unknown step falls back to the first |
| Only staff | `[x]` verified — a customer is redirected away from the wizard and gets 403 from the publish endpoint |

Two real gaps closed on the way:

- A product that varies by nothing could not get a variant at all: `generateVariants` returned nothing without attributes, so a simple product had nothing to price and could never be sold. It now creates one plain variant, idempotently. The old test asserted the broken behaviour and has been replaced.
- The readiness checklist originally included "every deposit variant states its percentage". That state cannot exist — `product_variants_deposit_requires_percent_check` refuses it in the database — so the check was removed rather than left as unreachable code, and a test now asserts the constraint is what enforces it.

Five e2e tests in `shipping.spec.ts` were marked `test.slow()` for the same reason as the earlier three: each runs a whole guest checkout before its assertion, and they timed out only under the load of the full suite.

## Landed price split, and site settings (added after Phase 15)

Every order now records what its landed price is made of, and the rates behind that split are editable at `/admin/settings` — a page the admin nav had linked to since Phase 11 without it existing.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm run build` | `[x]` passes |
| `npm test` | `[x]` passes — 445 passed, 1 skipped, 30 files |
| `npm run test:e2e` | `[~]` `e2e/landed-price.spec.ts` passes, 12 tests across mobile and desktop. **The full 298-test sweep was not run for this slice** — the run was stopped, so the suite is not verified end to end here. |
| The parts always sum to the total | `[x]` verified across many prices, including ones that do not divide evenly — rounding is absorbed by duty so the sum stays exact |
| Nothing is added at checkout | `[x]` verified in the browser: the cart figure carries through to checkout unchanged, and both say "Shipping and duty: Included" |
| Rates cannot change what is charged | `[x]` verified: the same order placed under two different duty percentages produces an identical total and an identical amount taken now |
| Freight cannot exceed the price | `[x]` verified: a cheap, heavy item yields all freight and zero goods rather than a negative goods value |
| Customer and staff both see the split | `[x]` verified on the guest lookup page and the admin order page |
| Only a super admin writes settings | `[x]` verified in `lib/` and at the API — staff read with disabled inputs and get 403 from `PATCH`, a customer is redirected and also gets 403 |
| A corrupt setting cannot break checkout | `[x]` verified: a hand-written non-numeric value falls back to the built-in default rather than throwing |
| Settings changes are audited | `[x]` verified in `lib/` and in the browser — the audit log shows the value that replaced the old one |

Two schema changes: `0004` adds `orders.duty_bdt`; `0005` widens `audit_log.entity_id` from `uuid` to `text`, because a site setting is keyed by name and the audit log has to be able to name what changed.

Note for the next session: the dev database has not had `npm run db:setup` run since these migrations were added.

## Accessibility audit (added after Phase 15)

`e2e/accessibility.spec.ts` runs axe-core over twelve pages — the four the spec names (search, browse, cart, checkout) plus the product page, sign-in, order tracking, an empty search result, and three admin screens — against `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa`.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 445 passed, 1 skipped, 30 files |
| Axe at AA, desktop | `[x]` 12 pages, zero violations |
| Axe at AA, mobile | `[x]` 12 pages, zero violations |
| Regression spot-check | `[x]` `storefront.spec.ts` and `acceptance.spec.ts` still pass after the palette change; the full sweep was not re-run |

The audit failed on eleven of twelve pages the first time it ran, all on one rule: `color-contrast`. The hand-written structural checks could not have caught it, which is the argument for running the real rule set.

What was wrong, measured against white:

- `blue-400` as text: **2.09:1**. It was being used for the eyebrow label above page titles and for breadcrumbs.
- `ink/40`, `ink/50`, `ink/60` as muted text: **2.42:1**, **3.17:1**, **4.27:1**. The last one looks fine and still fails.
- `brass`, `transit-green` and `stamp-red` as text: **2.06:1**, **3.19:1**, **3.58:1**.
- `blue-600` at **4.55:1** passed on white by 0.05 and failed on any tinted ground.

The fix was to the palette, not to the test. `blue-600` moved to `#2563eb` (5.17:1 on white, 4.81:1 on paper-raised). Muted text moved to `ink/70` (5.90:1). The three saturated colours keep their vivid values for fills, borders and badges — where contrast rules do not apply — and gained darker partners (`brass-text`, `transit-green-text`, `stamp-red-text`) used wherever the colour becomes words. The identity is unchanged; the words are readable.

## Shared rate-limit store (added after Phase 15)

Login attempt counts moved from a Map inside one Node process to the `rate_limit_hits` table (migration `0006`).

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm run build` | `[x]` passes |
| `npm test` | `[x]` passes — 457 passed, 2 skipped, 32 files |
| The count is shared | `[x]` verified: attempts from separate callers count against one limit, and windows are aligned to absolute time so processes agree without coordinating |
| Two simultaneous attempts cannot both take the last slot | `[x]` verified against a real PostgreSQL server with a warmed 20-connection pool, and **confirmed to fail** when the single upsert is replaced by a read-then-write: 20 of 20 attempts allowed instead of 1 |
| No email or address is stored | `[x]` verified: keys are SHA-256 hashes, and the stored key contains neither the address nor anything resembling it |
| One row per key and window | `[x]` verified under contention — 20 concurrent attempts produce one row with a count of 20, not 20 rows |
| A database outage does not lock anyone out | `[x]` verified by dropping the table mid-test: the attempt is allowed, and the reasoning is that sign-in needs the database anyway |
| Old windows are swept | `[x]` verified — closed windows are deleted, the current one is left, and the sweep is safe when there is nothing to delete |
| Auth and security e2e | `[x]` `auth.spec.ts` and `security.spec.ts` pass on desktop. The full sweep was not re-run. |

The previous limiter was honest about being process-local, but the deployment target is serverless: each instance counted separately and every deploy reset the count, so spreading attempts across instances defeated it. On PGlite nothing can genuinely race — it serves one connection — so the concurrency claim is proved in a separate suite against a real server, which skips loudly when that server is not running.

## Two-factor authentication (added after Phase 15)

TOTP with recovery codes, at `/account/security`, plus the second step at sign-in. Migration `0007`.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm run build` | `[x]` passes |
| `npm test` | `[x]` passes — 519 passed, 2 skipped, 33 files |
| TOTP is correct | `[x]` verified against the published vectors: all ten RFC 4226 counters and five RFC 6238 times, not against a phone |
| A secret does nothing until proved | `[x]` verified — an enrolment that is started but never confirmed leaves sign-in unchanged |
| The password alone is not enough | `[x]` verified in `lib/` and in the browser: the cookie is set, `validateSessionToken` refuses it, and `/account` still redirects to sign-in |
| A code cannot be used twice | `[x]` verified — the spent step is recorded and the same code is refused immediately after |
| Recovery codes work once | `[x]` verified end to end: one signs in, the same one is then refused, another still works |
| Codes are not readable back | `[x]` verified: only SHA-256 hashes are stored, and the test asserts the stored value is not the code |
| Turning it off needs a code | `[x]` verified — a live session alone is refused |
| Cross-account codes are refused | `[x]` verified for both app codes and recovery codes |
| Accessibility | `[x]` the new page is in the axe audit and passes at AA |
| `npm run test:e2e` | `[~]` `two-factor.spec.ts` passes, 12 tests across mobile and desktop, and `accessibility.spec.ts` plus `auth.spec.ts` pass on desktop. The full sweep was not re-run. |

One unrelated defect found on the way: `tests/seed.test.ts` applied only migration `0000`, so the seed was being checked against a schema the application left behind long ago. It went unnoticed because a failure in `beforeAll` is reported as skipped tests rather than failures — the run said "8 skipped" where it should have said "6 failed". It now applies every migration in order.

## Scheduled sweep (added after Phase 15)

`/api/cron/maintenance` delivers the outbox on a clock rather than on traffic, and tidies up while it is there. `vercel.json` schedules it every ten minutes. Migration `0008` adds the attempt count.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm run build` | `[x]` passes |
| `npm test` | `[x]` passes — 522 passed, 2 skipped, 33 files |
| `npm run test:e2e` | `[~]` `cron.spec.ts` passes, 14 tests across mobile and desktop. The full sweep was not re-run. |
| The secret is actually required | `[x]` verified four ways — no header, wrong secret, the secret without its `Bearer` prefix, and a signed-in super admin session — and **confirmed to fail**: weakening the check to allow a missing secret makes two of those tests fail |
| An unset secret closes the endpoint | `[x]` it returns 401 rather than running: a job runner anyone can trigger is worse than none |
| A failed message is retried | `[x]` verified: a provider that fails once and then recovers leaves the row `sent` with two attempts recorded |
| A hopeless message stops | `[x]` verified: after five attempts the row is no longer picked up, and stays `failed` for staff to see |
| A sent message is never re-sent | `[x]` verified — a second drain attempts nothing |

The sweep also prunes closed rate-limit windows and deletes expired sessions, both of which previously only happened opportunistically on a request.

## Open items carried from other docs

- `MASTER_PRODUCT_SPEC.md` open questions: minimum batch/order economics, exact refund policy detail, exact deposit/balance trigger.
- `SECURITY.md` open questions: 2FA for admin roles, data-retention period under Bangladeshi law.
- `DATABASE.md` open questions: whether balance payment is auto-triggered or staff-triggered; automatic waitlist re-offer vs manual.

These don't block Phase 1 (scaffold has no dependency on their answers) but should be resolved before Phase 6 (preorder engine) and Phase 8 (checkout) reach them.

## Storefront presentation, second pass (added after Phase 15)

The owner looked at the shop and said it read as "very simple", and asked for
something modern, animated and distinctive. This pass rebuilt the home page
around the one thing that makes this business different from a marketplace —
a batch that closes on a clock, with a countable number of places in it — and
put that fact everywhere a shopper looks.

What is new on the storefront:

- A hero that sets its headline a word at a time, carries the live countdown,
  the batch meter and a thumbnail strip of the rest of the featured batch.
- A manifest strip under it: a running line of facts about the shop and the
  batches genuinely open right now, with a real Hold button, because moving
  content has to be stoppable by someone with no pointer (WCAG 2.2.2).
- "Windows closing soon" — the open batches as a horizontal rail, ordered by
  what shuts first, each with a countdown and a capacity meter.
- A dark, full-bleed process band whose rule draws itself down the section as
  it is scrolled, so three steps read as one journey.
- A category bento with one large lead tile, each carrying a real photograph of
  something filed in that shelf and a real count of what is in it.
- Product cards that carry the batch meter, and state how many places are left
  when the number is genuinely small.
- A header that tightens on scroll and moves its categories behind a button on
  a phone.

The catalogue grew from 14 seeded products in 6 categories to 24 in 13, across
five top-level shelves, with ten new illustrations. A grid of four items made
every layout look like a shop that had not opened yet.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 515 passed, 9 skipped, 33 files |
| `npm run test:e2e` | `[x]` passes — 362 passed, 4 skipped, mobile and desktop |
| Axe at AA | `[x]` 26 checks over twelve pages, mobile and desktop, zero violations |
| UI inspected | `[x]` home page viewed at 375px and 1440px against the real catalogue |
| No sideways scroll | `[x]` asserted at 320px and checked at 375px |
| No console errors | `[x]` checked in a real browser at both widths |

### Three defects found by looking rather than by testing

**Entrances that hid the page.** The first version used Framer Motion's
`whileInView`, which puts `opacity: 0` into the server-rendered HTML — so
anything below the fold was present in the DOM and blank on screen for anyone
whose JavaScript failed, and in every capture that does not scroll. The second
attempt used CSS `animation-timeline: view()`, which removes the JavaScript but
*scrubs*: scrolling back up ran the entrance backwards and faded out sections
that had already been read. What ships now hides only what is genuinely below
the fold at mount, plays each entrance once, and never touches anything already
on screen. The rule it enforces: **an entrance may never be the reason
something cannot be read.**

**A hydration mismatch on every page with a countdown.** `Countdown` read
`Date.now()` for its first client render, which is never the number the server
had already put in the HTML. React reported a hydration error and discarded the
subtree. The render instant now comes from the database — the same clock that
decides `closingSoon` in SQL — and is passed down, so both sides render the
same figure.

**A meter that could show the wrong number.** The capacity bar animated its
width from zero, which means a browser that never ran the animation showed an
empty batch. The width is now correct in the markup and only *scaled* by the
animation, so the failure mode is a missing effect rather than a wrong figure.

### Contrast, again

The axe audit failed 18 of 26 checks the first time it ran on the new header.
Two causes, both real: the batch meter had no accessible name
(`aria-progressbar-name`), and the header used a translucent blue behind white
text — white at 90% over `blue-600` measures **4.15:1**, under the 4.5:1 floor.
The header is now opaque and its text fully white; no opacity is used on text
anywhere on that ground.

### Four end-to-end tests were asserting things that had stopped being true

Fixed rather than deleted, and worth recording because three of the four were
already failing before this pass:

- `tests/rate-limit.test.ts` counted attempts against the wall clock with a
  one-second window aligned to absolute time, so four calls that straddled a
  second boundary landed in two windows and the count restarted. It failed
  roughly whenever the run crossed one. The instant is now pinned.
- A missing product was asserted to return **404**. It returns **200**. This
  route renders a `loading.tsx`, so the response starts streaming before the
  page body runs, and the status cannot be changed once headers are sent — this
  is documented Next.js behaviour, and Next injects
  `<meta name="robots" content="noindex">` instead, which is what actually keeps
  the URL out of a search index. The test now asserts the guarantee that holds.
  A real 404 status would need a `proxy` check before the body streams.
- Three tests named a specific seeded product and assumed it appeared on the
  home page. A 24-product catalogue pushes the two oldest off it. They now
  assert against whatever the home page is showing, which is the behaviour
  worth guarding.
- One asserted a price with `getByText(/^BDT [\d,]+$/)`. `Intl` puts a
  **non-breaking space** after the currency code, so a literal space never
  matches.

Not done in this pass, and carried forward:

- `[ ]` The category, search and product pages have not had the same treatment.
  They work and they pass, but the second pass stopped at the home page.
- `[ ]` Real photography. Every image is still an illustration; the storage
  integration and `next/image` are unchanged.
- `[x]` The production JavaScript budget was re-measured — see below.

### The JavaScript budget, re-measured with Framer Motion in the build

`docs/DESIGN_GUIDELINES.md` sets 200KB gzipped. Measured against a production
build:

| Page | Raw | Gzipped |
| --- | --- | --- |
| Product detail | 470.6 KB | **140.7 KB** |
| Home | 594.9 KB | **181.4 KB** |

The product page was 136.1 KB before this pass, so the motion library costs it
about 4.6 KB. The home page is the heaviest on the site and the one a first-time
visitor lands on, and it was **192.0 KB** — 8 KB of headroom — until the process
band's scroll-linked rule moved from a Framer spring to a CSS scroll timeline,
which took 10.6 KB off it. That is the right tool there twice over: a progress
line *should* run backwards as you scroll back up, which is the behaviour that
made scroll timelines wrong for entrances, and it costs no JavaScript at all.

`e2e/seo.spec.ts` now asserts the budget on **both** pages. It previously
watched only the product page, which is not the one at risk.

## A production-only defect in product media (found after Phase 15)

An uploaded photograph returned **404 under `next start`** while working
perfectly in development. The local media provider wrote into `public/uploads`,
and Next resolves that directory when the application is built — a file written
there afterwards is never served. Every admin upload would have been broken in
production, and nothing caught it because the media suite had only ever been run
against the dev server.

Uploads now go to `.uploads/` outside `public/`, served by a route handler at
`/uploads/[key]` that reads from disk per request. That works in both modes and
is closer in shape to the Cloudflare R2 implementation named in DECISIONS.md
D-001, where the bytes never sit beside the application at all.

| Gate | Result |
| --- | --- |
| An uploaded photograph is served in production | `[x]` verified by `npm run test:e2e:prod`, which is what found the defect |
| The route refuses anything but a generated key | `[x]` verified for three traversal spellings, a non-image extension, and a well-formed key that does not exist |
| `npm run test:e2e:prod` | `[x]` passes — 366 passed, 4 skipped, against a production build |

The key is matched against the exact UUID-and-extension shape the system
generates rather than merely being checked for `..`: a whitelist cannot be
talked into matching a path, and a blacklist eventually can.

## Preorder window controls (added after Phase 15)

The capacity engine has been in place and tested since Phase 6, and until now
there was no screen that could reach it: a window could only be set by typing
values in when a variant was first created. `/admin/products/<id>/windows` opens,
extends and closes a window per variant, and shows capacity, reserved,
remaining and how many people are waiting.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 522 passed, 2 skipped, 33 files |
| `npm run test:e2e` | `[x]` passes — 380 passed, 4 skipped, mobile and desktop |
| Axe at AA | `[x]` the new screen is in the audit and passes — 28 checks over thirteen pages |
| UI inspected | `[x]` viewed at 375px and 1280px against the seeded headphones, which have one open variant and one deliberately full |
| A window opens, extends and closes | `[x]` verified end to end in the browser, with the figures read back from the server after a reload rather than from the optimistic message |
| Closing keeps the reserved places | `[x]` verified: the reserved count is identical before and after, because those are orders that still have to be fulfilled |
| Capacity cannot drop below reserved | `[x]` verified at the API with a hand-written request — 400 with the reason, not a silent clamp |
| A closing date in the past is refused | `[x]` verified at the API |
| An unknown field is refused | `[x]` verified: a request that also tries to set `preorderReserved` is rejected rather than partly applied |
| Only staff | `[x]` verified — 403 for a signed-in customer on both open and close, 401 anonymous |

Two things worth recording:

- The request body is a discriminated union rather than one shape with optional
  fields. "Close" takes nothing, and a request that closes a window while also
  carrying a capacity is a confused request, not a lenient one.
- Whether a window has already shut is decided against the database clock and
  passed to the client, not read from `Date.now()` during render. That is the
  same fix as the countdown: reading a clock during render is impure, and it is
  also the wrong clock, since everything else in this system decides "closed" in
  SQL.

Still carried forward from Phase 6: notifying the waitlist when capacity frees
up. The count is now visible on this screen, but nothing is sent.
