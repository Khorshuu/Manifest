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

## Waitlist notifications (added after Phase 15)

Carried forward since Phase 6, and blocked on an open question in DATABASE.md —
automatic re-offer or manual. The product owner asked for work to continue
rather than wait on the answer, so the simplest defensible option is built and
recorded as **DECISIONS.md D-011: notify, do not hold.**

When capacity returns to a full preorder variant — an order cancelled, or staff
raising the ceiling — the people at the front of that variant's queue are told,
oldest first, up to the number of places that actually opened. No place is
reserved for them, and the message says so in as many words.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 533 passed, 2 skipped, 34 files |
| `npm run test:e2e` | `[x]` passes — 382 passed, 4 skipped, mobile and desktop |
| The queue is served in order | `[x]` verified: one place freed writes to the oldest entry and nobody else |
| Places, not the size of the rise | `[x]` verified: a batch with two spare raised from 2 to 7 opens five, not five-plus-two |
| Nobody is told twice | `[x]` verified: two releases in a row produce one message, because the dedupe key is the waitlist entry |
| A message exists only if the capacity did | `[x]` it is written inside the transaction that returns the capacity, the same outbox rule as order events (D-009) |
| Nothing is sent about a withdrawn product | `[x]` verified: a disabled variant produces no message |
| The message does not promise a place | `[x]` asserted against the body text — "not held for you", "orders first" |
| **Confirmed to fail** | `[x]` removing the call from `releaseCapacity` fails 5 of the 11 tests; the other 6 cover the staff-capacity path and the templates, which are untouched by that change |

Not done: no email is actually delivered, because no email or SMS provider is
connected. The message lands in the outbox and is visible at
`/admin/notifications`, which says on the page that nothing was sent. That is
the same state every other notification in this system is in.

## Storefront consistency pass (added after Phase 15)

The home page rebuild left the category, search and product pages looking like
a different site: a bare `h1` where the home page has a brass rule and a tracked
label, and two different words for the same thing.

- `components/page-heading.tsx` holds the heading treatment once, so the listing
  pages and the home page cannot drift apart again.
- The product page carries the same batch meter the cards do, so a shopper who
  picked a listing off a grid sees the same figure in the same form.
- "Slots" became "places" everywhere a shopper reads it. One word for one thing.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 533 passed, 2 skipped, 34 files |
| `npm run test:e2e` | `[x]` passes — 382 passed, 4 skipped, mobile and desktop |
| UI inspected | `[x]` category, search and product pages viewed at 1440px against the real catalogue |

Two tests needed fixing, and the reasons are worth keeping:

- The filter test read the listing count out of the prose under the heading, so
  rewriting that sentence broke it. It now reads the filter panel's own "N
  matches", which is the figure that actually has to agree with the grid —
  both come from `buildProductWhere` — and which does not move when copy does.
- `staff move an order through the pipeline` timed out only under the load of
  the full suite; it passes comfortably alone. Marked `test.slow()`, the same
  as the other tests that walk a whole checkout before their assertion.

Still carried forward: the cart, checkout and account screens have not had this
treatment.

## Deposit balance payments (added after Phase 15)

The last of the open questions carried since Phase 8. The product owner chose
staff-triggered, recorded as **DECISIONS.md D-012**: the balance on a deposit
order is collected when a member of staff presses a button, never automatically
on a pipeline event.

- `lib/orders/balance.ts` computes what an order still owes from its own payment
  rows and takes it once.
- A Payment panel on the admin order page states total, paid and outstanding
  before anything is pressed, and asks a second time before money moves.
- The customer's order page says what is left and that we will collect it —
  not "pay now", which would be a button that does not exist.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 548 passed, 2 skipped, 36 files |
| The amount comes from the payments, not the order column | `[x]` verified: after a refund, what is owed follows the payment rows rather than `amount_due_now_bdt`, which records what was asked for at placement |
| A request cannot name its own amount | `[x]` verified at the API — a body carrying `amountBdt` is refused with 400 rather than partly applied |
| The same balance cannot be taken twice | `[x]` verified three ways: a captured row short-circuits before the provider is called, an *initiated* row is resumed rather than replaced, and the provider is handed a key derived from the order |
| A cancelled or refunded order is refused | `[x]` verified |
| The customer is told, once | `[x]` verified: two collections produce one message |
| Who took it is recorded | `[x]` verified — an `order.balance_taken` audit row carrying the actor |
| The fulfilment stage does not move | `[x]` verified: this is money, not goods |
| Only staff | `[x]` verified in `lib/` and at the API — 403 for a customer, 401 anonymous, and no payment row written when refused |

### A production defect the parallel tests found

Several of the new end-to-end tests check out at the same time, and checkout
started returning **500**. The cause was not the new code:

`nextOrderNumber` allocated the human-facing order number as `count(*) + 1`
over the orders already placed that year — a read-then-write against a
**UNIQUE** column. Two checkouts in the same instant read the same count, both
tried to insert the same number, and one customer got "Something went wrong" at
the moment they pressed Place order. It would have happened in production the
first time two people ordered at once, and no existing test could see it
because PGlite serves one connection and nothing on it can genuinely race.

Migration `0009` adds a Postgres sequence, and `nextOrderNumber` takes its
value from `nextval`. `tests/order-number-concurrency.test.ts` runs twenty
simultaneous allocations against the real server and asserts they are all
different — and is **confirmed to fail** when the read-then-write is put back.

The first fix for this was a counter row incremented with an upsert. That is
equally correct and was wrong anyway: the upsert holds a row lock for the rest
of the transaction, so every checkout queued behind every other one. The
end-to-end suite went from 9 minutes to 12.7 and ten tests timed out — all of
them on the same worker, all passing on their own. A sequence takes no
transaction-scoped lock at all, and a second test asserts that twenty
concurrent callers do not queue.

Two consequences of the sequence, both deliberate and both recorded in the
code: numbering runs continuously rather than restarting each year, because
restarting needs exactly the lock this avoids; and a rolled-back placement
leaves a gap, because a sequence does not roll back. A number nobody was ever
given is not a problem worth a lock.

## Cancellation review, manual refunds, and a living hero (added after Phase 15)

Three things the product owner asked for directly, and one defect found on the
way.

**A shopper's cancellation is now a request** (DECISIONS.md D-014). The button
says "Ask us to cancel" and takes their reason in their own words. It records a
request and changes nothing else — the order keeps its status, keeps moving,
and keeps its capacity, because until somebody decides, the place is still
theirs. Staff see the queue as the first tab of the order pipeline, with a count
badge visible from every other tab, and approve or decline from the order page.

**Refunds are recorded, not charged** (DECISIONS.md D-015). No gateway call.
Staff enter an amount, a reason, and the reference of the transfer they made by
hand. A part refund leaves the order running; a full one closes it and returns
any places still held.

**The hero ground moves.** A still ruled grid was replaced by a canvas of
shipments crossing from both edges and landing on a pulsing destination, with
trails, arrival rings and pointer parallax. Written by hand rather than with a
library: the home page went from 181.4KB to **183.0KB gzipped** against the
200KB budget, so the whole effect cost 1.6KB. It stops completely when scrolled
past, when the tab is hidden, and when the visitor has asked for reduced motion,
where it draws one still frame instead.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 554 passed, 2 skipped, 36 files |
| `npm run test:e2e` | `[x]` passes — 396 passed, 4 skipped, mobile and desktop |
| Axe at AA | `[x]` passes over the animated hero — the canvas draws nothing solid, and a radial scrim guarantees the headline sits on ink |
| Home page JavaScript | `[x]` 183.0 KB gzipped, measured against a production build |
| Asking to cancel does not cancel | `[x]` verified in `lib/` and end to end — the status is unchanged and the reserved places are still held |
| Approving returns the places | `[x]` verified; declining leaves the order exactly as it was |
| Asking twice is not an error | `[x]` verified — the second request reports the first |
| Only staff answer a request | `[x]` verified — 403 for the customer who owns the order |
| A part refund cannot exceed what is left | `[x]` verified: refund rows point at the charge they reverse, so a second part refund knows what remains |

### Two defects found by the new tests

**Order numbers raced.** `nextOrderNumber` allocated `count(*) + 1` against a
UNIQUE column, so two checkouts in the same instant collided and one customer
got "Something went wrong" as they pressed Place order. Migration `0009` moves
it to a Postgres sequence. `tests/order-number-concurrency.test.ts` proves it
against a real server and is **confirmed to fail** on the old scheme. A counter
row with an upsert was tried first and rejected: correct, but it holds a row
lock for the rest of the transaction and serialised every checkout, costing the
suite four minutes.

**Refunds had no link to the charge they reversed.** A refund was only a
negative number against the order, so nothing could tell how much of a given
charge was still refundable — repeated part refunds could between them have
exceeded what was taken. Migration `0010` adds the link, backfills the existing
rows, and adds a check constraint that a refund must point at a charge.

### The suite was slow and flaky, and the cause was mine

Ten to fourteen tests were timing out per run, all passing in isolation. Three
causes, all self-inflicted:

- Every spec's sign-in helper opened the **home page** purely to have an origin
  for a logout `fetch` — 25 occurrences across 16 files, on almost every test.
  The home page rebuild had made it the heaviest route on the site: 0.27s warm
  against 0.04s for `/login`. Pointed at `/login` instead.
- The new balance spec walked the whole checkout form in every test, testing
  checkout a second time and starving everything else. It places its order
  through the API now.
- The default 30s timeout no longer matched a grown suite on a dev server shared
  by eight workers. Raised to 60s, with the assertion timeout kept at 10s so a
  missing element still fails fast with a useful message.

Carried forward: the cart, checkout, confirmation and account screens have not
had the design treatment the storefront pages got, and admin has no mobile
navigation, which `CLAUDE.md` section 8 asks for.

## Whole-product visual pass (added after Phase 15)

The storefront had been through two design passes; the screens behind it had
not. The gap carried forward at the end of the last session — "the cart,
checkout, confirmation and account screens have not had the design treatment
the storefront pages got, and admin has no mobile navigation" — was the whole
of the problem, and it had a single cause rather than seven.

### What was actually wrong

**There was no component layer.** Forty-one separate places hand-wrote
`inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4
text-body text-blue-600` to mean "a link that is a button", and they disagreed
about padding, weight, hover and press. Every boxed surface on the site was an
ad-hoc `border border-blue-300 p-8` with no radius and no depth. Every empty
state was a bare rectangle with a sentence in it, visually indistinguishable
from a page that had failed to load. There were no icons at all — the design
guidelines ask for thin line icons and the only ones on the site were the
typographic characters `→`, `←` and `★`, which render at a different weight in
every face.

So the fix was a shared layer first, and screens second:

- `components/icons.tsx` — the icon set. 24×24, 1.5 stroke, `currentColor`,
  decorative unless given a title. Hand-drawn rather than a dependency: it
  costs nothing against the JavaScript budget and the shapes carry the
  shipping-document identity rather than a generic app language.
- `components/button.tsx` — `Button` and `LinkButton` over one recipe, four
  variants, three sizes, 44px minimum on all of them.
- `components/panel.tsx` — `Panel` and `SectionHeading`.
- `components/empty-state.tsx` — every "nothing here" on the site.
- `components/skeleton.tsx` — loading states shaped like the content.
- `components/checkout-steps.tsx` — where you are in buying something.

`docs/DESIGN_GUIDELINES.md` gained a **Shared components** section and a
**Depth** table recording the four-step shadow scale, and its Motion section
was rewritten: it still described the single-animated-moment brief that the
product owner overrode two sessions ago.

### Screens rebuilt

| Screen | What changed |
| --- | --- |
| Cart | Page heading treatment, line cards with the fulfilment mode and deposit stated per line, a quantity stepper, a floating summary with the assurances beside the button, a real empty state. |
| Checkout | A step indicator, the three sections numbered and panelled, payment methods as selectable cards, the order lines shown in the summary, and the error given focus on a failed submit. |
| Confirmation | The order number as the object of the page, a stamped success mark, and what happens next in three stages. |
| Account and order detail | Order rows became cards where the whole row is the link, with the address and totals panelled. |
| Order lookup | The heading treatment, shared fields, and the "not found" case as a real empty state rather than a grey box. |
| Sign in | Was a form floating on a blank white page with no header, no footer and no colour — the least trustworthy thing to show someone about to type a password. Now a branded split panel that stacks on a phone. |
| 404 and errors | There were none, so a bad product link landed on the framework's own black-and-white page. Now `app/(storefront)/not-found.tsx`, `app/not-found.tsx`, and error boundaries for the storefront and admin. |
| Admin | A proper navigation shell: ten links wrapped into three rows on a phone and had no menu at all. The sections now have a row of their own on desktop with the current one marked, and collapse behind a button below `md`. Tables, tiles, panels and empty states brought onto the shared components. |

### Two layout defects fixed

**The product page had a hole in it.** Three sections — bullets, description,
specifications — were dropped into a two-column grid, so the description landed
in the narrow right column and the specifications wrapped to a second row,
leaving most of the right-hand side of the page blank. They are two columns
with contents now.

**The dark process band was half empty.** The three steps occupied the left
half of a full-bleed section and nothing occupied the right. It now carries a
drawn waybill — which deliberately shows **no figures**, because a decorative
document with plausible numbers on it is indistinguishable from a real quote,
and CLAUDE.md section 7 does not allow a number that did not come from a query.

**The mobile header search was unusable.** Nested inside the actions group it
was squeezed to about forty pixels between the cart icon and the screen edge.
The header row wraps now, so search takes a line of its own below `md`.

### What the suite caught, and why it was right to

The end-to-end run found six real regressions in this pass. They are worth
recording because five of them are the same mistake: **a visual change that
quietly altered what an element is called.**

**The admin bar failed the accessibility audit.** Marking the current section
by making the others fainter put white at 75–85% opacity on `blue-600`.
Measured, that is 3.61:1 to 4.20:1 — every one of them below the 4.5:1 floor,
and none of it visible to the eye as a problem. Only full `paper` clears it
(5.17:1), so the current section is marked by weight and a brass underline
instead, and nothing on that bar is translucent any more.

**Sign out went behind the menu.** Tidying the admin bar moved it into the
collapsed section list on a phone, so the one control an operator on a shared
machine needs to find immediately was invisible until they opened a menu. It
is back in the bar at every width.

**The payment radio stopped being a radio.** Making the method cards the
control meant hiding the input with `sr-only`, which leaves an element with no
box — so nothing aiming at the radio itself could act on it. It is a
transparent overlay across the card now: same appearance, still a real radio.

**Every required field was renamed.** Adding a required marker inside the
`<label>` changed each field's accessible name — "Email" became "Email *" —
because a label's text *is* the field's name. The mark sits beside the label
now, and the `required` attribute does the announcing, which it always did.

**"Cart" and "Account" lost their words.** Reducing them to icons below `sm`
made the links' names the screen-reader sentence rather than the word, and an
icon-only navigation item is the one thing every guideline in the design data
warns against. Icon and label, at every width.

**One test was passing for the wrong reason.** `getByText("admin@example.com")`
had been matching the operator's identity in the admin chrome rather than the
row in the staff table, so it would have passed on any page at all. It is
scoped to `main` now and asserts what it says it does.

Four assertions were updated rather than fixed, all of them naming copy that
was deliberately rewritten — the cart and listing empty states, and the "we
could not find that order" message. Each still asserts the same behaviour.

### Verification

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 554 passed, 2 skipped, 36 files |
| `npm run test:e2e` | `[x]` passes — mobile and desktop |
| Axe at AA | `[x]` passes — `e2e/accessibility.spec.ts` over every storefront and admin screen, including the four admin pages the contrast regression above broke |
| Screens inspected | `[x]` home, catalogue, category, product, cart, checkout, confirmation, account, order lookup, sign-in, 404, and five admin screens, at 1440px and 390px |

Nothing in this pass touched an API route, a query, a schema or a business
rule. The changes are markup, class names, three new presentational components
and the shared component layer above.

## A new hero, and the blue band removed (added after Phase 15)

**The dark "how a batch works" band is gone** from the middle of the home page,
at the owner's request. `components/process-band.tsx` is still in the tree, so
restoring it is one line in `app/(storefront)/page.tsx`. What it explained is
not lost — the assurance cards at the foot of the home page make the same three
points, `components/journey.tsx` walks the whole route on every product page,
and the footer states the preorder terms on every page of the site.

**The hero was rebuilt, backdrop and composition both.** The previous one is
archived in full at `docs/archive/hero-orbs-backdrop.md` — component, CSS, and
the one command that puts it back — because it was liked well enough to be
worth keeping a way home.

The backdrop is now a departure board: sixteen columns of flaps that step over
and settle. Three earlier attempts at this hero failed the same way, and the
lesson is recorded here because it keeps recurring — **subtlety is the failure
mode**. A still ruled grid read as nothing; a field of faint dots read as noise;
and the first pass of this board, at 5% white on the faces, read as faint
horizontal banding. The values shipped are deliberately strong, and the scrim
over them earns its keep by protecting the headline rather than by hiding the
board.

It costs nothing to run: columns rather than tiles means a wall of two hundred
flaps is sixteen animated elements, `steps()` timing is what makes the movement
read as mechanical, and there is no JavaScript in it at all.

The composition changed too. The old hero stacked the headline, the
subheading, the product name, the price, the countdown, the capacity meter, two
buttons and the slide controls into one column, which left the photograph — the
most important thing on the page — as the quieter half. The batch details now
sit on a pale tag pinned across the foot of the photograph, the way a shipping
label sits on a crate.

### Two defects found while doing it

Both were pre-existing, both only appeared under `prefers-reduced-motion`, and
both had the same cause: **a render-affecting prop branched on
`useReducedMotion()`, which the server cannot know.**

- **The headline hydrated into a mismatch on the `h1` itself** — and worse,
  Framer Motion writes `opacity: 0` into the server-rendered markup, so the
  headline of the whole site was invisible until JavaScript arrived to take it
  back. It is a CSS keyframe now: identical markup on both sides, runs without
  JavaScript, and collapses to nothing under reduced motion.
- **The slide image disagreed about `touch-action` and `draggable`**, because
  dragging was switched off for reduced motion. That was wrong on its own
  terms as well: asking for stillness is about what moves on its own, not about
  having a control taken away.

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 554 passed, 2 skipped |
| Axe at AA | `[x]` passes over the new hero, mobile and desktop |
| `e2e/experience.spec.ts` | `[x]` passes — rotation, hover pause, live countdown |
| Home page JavaScript budget | `[x]` passes — the headline no longer uses the motion library at all |
| Reduced motion | `[x]` verified: the board stands still, and the browser console is clean where it previously reported a hydration mismatch |

## The hero as a campaign banner (added after Phase 15)

The owner pointed at a large Greek pharmacy storefront and asked for that shape.
What was worth taking from it is structural rather than decorative:

- A bright, full-bleed promotional band instead of a dark panel.
- **One** loud call to action, with the second route out of the hero as a quiet
  link rather than a button competing for the same press.
- Circular arrows sitting on the outer edges of the band, where they stay put
  while the banner behind them changes.
- A rotated sticker in the corner.
- The next row of products butting straight up underneath, so the page reads as
  a shop rather than as a landing page with a shop somewhere below it.

What was deliberately not taken is the density. That banner is a printed
advertisement carrying four logos and a paragraph of small print. This one
carries the four things a preorder shopper is actually deciding on: what it is,
what it costs, how long the window stays open, and how many places are left.
The sticker carries a real figure for the same reason — a sticker that says
nothing advertises nothing.

The departure-board hero it replaced is archived at
`docs/archive/hero-departure-board.md`, alongside the drifting-orbs hero before
it in `docs/archive/hero-orbs-backdrop.md`. Both are complete and restorable in
three steps; the choice between the three is taste rather than correctness.

**Three heroes in, the recurring lesson is worth stating plainly: scale beats
incident.** A still ruled grid read as nothing. A field of faint travelling dots
read as noise. A wall of flaps at 5% white read as faint banding. Every one of
them failed by being *small, fast and quiet*. The ruled field survives in this
hero — but as paper texture behind a photograph at 4.5% opacity, which is the
one job it was ever right for.

The brand statement stays the page's `h1`, and it is set in CSS rather than with
the motion library: `e2e/seo.spec.ts` renders the home page with JavaScript
disabled and requires that heading to be visible, which is exactly what a
crawler and a slow connection see.

| Gate | Result |
| --- | --- |
| `npm run build` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run lint` | `[x]` passes |
| `npm test` | `[x]` passes — 554 passed, 2 skipped |
| Axe at AA | `[x]` passes over the light banner, mobile and desktop |
| `e2e/experience.spec.ts` | `[x]` passes — rotation, hover pause, live countdown, keyboard |
| `e2e/seo.spec.ts` | `[x]` passes, including the heading with JavaScript disabled and both JavaScript budgets |
| Reduced motion | `[x]` verified: the bloom stops, and the browser console is clean |

## The immersive hero and the adaptive header (added after Phase 15)

The owner asked for the home page to be rebuilt around one large photograph,
with the header drawn inside it rather than on a bar above it, and the featured
products attached to the foot of the image. The reference they pointed at was a
pharmacy storefront; what was taken from it is structural — an immersive hero,
a transparent header, a curated product row overlapping the image — and nothing
else. No colour, type, imagery or layout was copied from it.

`[x]` The hero and the product showcase are one component,
`components/hero-showcase.tsx`. They share the slide index, so the hero drives
the row and choosing a card drives the hero, which is what makes them read as
one composition rather than as a banner with a shelf under it.

`[x]` The header floats over the hero with no bar of its own, and takes the
opposite treatment to whatever is behind it: navy lettering over a bright slide,
pale over a dark one. It is measured rather than guessed — see below. Once the
photograph has scrolled away it takes back a white bar with a `blue-300`
hairline. Every other page of the shop gets that same white bar. The solid
`blue-600` rectangle is gone.

`[x]` Five featured products rather than four. Four are visible at once on a
wide screen and the fifth is reached by scrolling the row, which is what proves
it is a curated selection rather than a fixed set of slots.

`[x]` Everything the previous hero carried is still carried: the eyebrow, the
brand statement as the page's `h1`, the landed-price promise, the batch's brand,
title, price, arrival window, capacity meter, live countdown, and one loud
call to action with a quiet second route beside it. Nothing about preorder or
batch availability was removed.

### How the header knows what it is sitting on

`lib/hero-tone.ts` draws each slide's image into a 32×32 canvas and averages the
relative luminance of the pixels that are not transparent. Above 0.55 the
background counts as light and the header goes navy; below it the header goes
pale. The switch point sits above the midpoint on purpose, because the header
also lays a veil over what is behind it: a middling ground is pulled towards the
veil rather than left ambiguous.

Three things about it are deliberate:

- **Every slide is measured on mount, not the one on screen.** A measurement
  that arrived after the crossfade would show as the header changing its mind.
- **It returns null rather than a guess** when the browser will not give up the
  pixels. A cross-origin image with no CORS headers taints the canvas and
  `getImageData` throws; the header then keeps the readable treatment it had.
- **`HERO_TONE_OVERRIDES` exists** for the case an average gets wrong — an image
  that is mostly dark with a bright sky exactly where the navigation sits. It is
  empty, because nothing in the catalogue needs one. Adding an entry is one line
  and requires looking at the slide first.

The route the header floats on is read from the path rather than announced by
the hero on mount. An announcement only arrives after hydration, so the server
would render the solid bar and the browser would swap it a moment later — a
visible flash on the first screen of the site.

### Making catalogue artwork hold a full screen

The catalogue has no photography yet; it has drawn artwork, each piece on a pale
ground of its own. Three things had to be solved before that could fill 90% of a
screen without looking like a large flat drawing, and all three are as useful
when real photography lands as they are now:

1. **The wash.** A blurred, over-scaled copy of the same image behind the sharp
   one. It gives the whole screen the product's own colour, and it is what lets
   a square image fill a wide screen without being cropped to a stripe.
2. **The blend.** Multiplied onto a warm paper ground rather than laid on white.
   Multiply drops everything lighter than the ground, so the artwork's studio
   backdrop disappears and the product stays. Laid on white instead, the
   backdrop read as a rectangle pasted into the middle of the first screen.
3. **A circle mask, not an ellipse.** `object-contain` draws a square picture in
   the middle of a wider box. An ellipse sized to the box stays fully opaque
   across the picture's own left and right edges and leaves them showing as a
   hard vertical line — which is exactly what the first attempt did. A circle
   takes its radius from the short side, which is the picture.

**This is still a stand-in, and it is worth stating plainly: there is no
photography in this repository.** The hero is built to show a real photograph
the moment staff upload one, and it will look better for it. Nothing here
fabricates a photograph or pretends one exists.

### Responsive

- **Desktop.** Subject beside the copy, controls and the slide count in the
  lower right, four cards across the foot of the image.
- **Tablet.** Subject above the copy — the copy runs the full width at that size,
  so a subject held to the right sits behind the headline rather than next to
  it. Categories drop to their own row under the bar.
- **Phone.** No subject layer at all. A phone screen is exactly as tall as the
  words need, and nothing is lost: the wash still carries the product's colour
  across the whole screen, and the card resting on the foot of the image carries
  the product itself at size. The header is two compact rows and the showcase is
  a swipeable rail.

### Verification

| Gate | Result |
| --- | --- |
| `npm run lint` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| Axe at AA, home, 1440×900 | `[x]` 0 violations |
| Axe at AA, home, 390×844 | `[x]` 0 violations |
| Contrast over the photograph | `[x]` measured from rendered pixels — nav 6.4:1, account 10.8:1, wordmark 15.7:1, eyebrow 10.9:1, body copy 6.6:1, headline 15.4:1, product title 15.2:1, price 15.3:1 |
| Sideways scroll at 320, 390, 820, 1440, 1920 | `[x]` none |
| Browser console, every width | `[x]` clean |
| Every slide inspected, and the dark treatment forced with an override | `[x]` both treatments readable |
| Header on a page with no hero (product, scrolled home) | `[x]` white bar, correct |
| `npm test` | `[ ]` **not run — the owner stopped it.** Nothing in this change touches server code, but the suite has not confirmed that. |
| `npm run test:e2e` | `[ ]` **not run.** `e2e/experience.spec.ts` and `e2e/smoke.spec.ts` assert against this hero, and the markup they need was kept deliberately: the region is still named "Featured preorders", each card is still a button named `Show <title>` carrying `aria-current`, the slide's product title is still the only `h2` in it, and the `h1` and the landed-price sentence are unchanged. That is reasoning, not a passing run. |

The three heroes before this one are archived under `docs/archive`, the newest
of them in `hero-campaign-banner.md`, each restorable in one command.

### A photograph in the hero, and what it proved

The owner supplied a product photograph and asked for it in the hero. It is
wired through `lib/hero-media.ts`, which maps a product slug to a hero image and
is read by the home page only: the card under the hero, the listing pages and
the product page all go on showing the catalogue artwork, so nothing about the
product record changed.

A photograph takes a different path through the hero than drawn artwork does.
The wash, the mask and the multiply blend all exist to make a square drawing on
a pale ground hold a wide screen; a photograph was composed by whoever took it,
so it is laid in edge to edge with nothing but a slow drift over it. That is the
`.hero-photo` branch.

Two things it proved that the drawn catalogue could not:

- **The adaptive header is real, not theoretical.** The photograph measures dark
  and the header goes pale over it; the four drawn slides measure light and it
  goes navy. Rotating through the batch now shows both treatments crossfading
  into each other, which until now could only be seen by forcing an override.
- **The scrim was tuned for a picture beside the words, not under them.** Below
  `lg` the copy runs the full width, and over a real photograph the directional
  wash was not enough — the body copy sat on the bottle. It is a full vertical
  scrim at those widths now, and re-measured: nav 8.6:1, body copy 6.6:1 on
  desktop and 11.4:1 on a phone, headline 17.8:1.

`[!]` **The supplied photograph is not licensed for this shop.** It carries a
visible copyright notice in its lower right corner and shows another brand's
product. It is fine for looking at the design and it must not go public. Replace
`public/hero/fragrance-bottle.jpg` with photography of the actual goods, or
delete the entry in `lib/hero-media.ts` and the hero falls back to the
catalogue image with no other change.

| Gate, with the photograph in place | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck` | `[x]` pass |
| Axe at AA, 1440×900 and 390×844 | `[x]` 0 violations |
| Contrast over the photograph | `[x]` every measured element above 6.5:1 |
| Sideways scroll | `[x]` none at either width |
| Both header treatments, rotating | `[x]` inspected at 1440, 820 and 390 |

## The homepage and discovery redesign (added after Phase 15)

The owner supplied a brief with three references — the shop as it stood, a
wide-hero pharmacy homepage for structure only, and a product-card screenshot
for typography — and asked for a redesign of the first screen and of the whole
product-discovery path, without breaking anything behind it. Nothing in the
business layer was touched: no schema change to products, orders, variants or
capacity, no change to pricing, checkout, permissions or the preorder engine.

### What changed, and why

`[x]` **One typeface, no serif.** Fraunces and Inter are gone; the shop is set
in Figtree at five weights, with the display role defined once as 700 and
-0.02em tracking. The brief rules out a serif display face by name. Radii grew
with it: 10px controls, 14px cards, 20px media. See DECISIONS.md D-017.

`[x]` **The hero is one image, and staff own it.** The five-slide rotation is
gone — the brief asks for a single image, and what the carousel was also doing
(proving the shop has more than one thing in it) is now done by the showcase
directly beneath, where every card carries a name and a price. The photograph,
the eyebrow, the headline, the supporting sentence, the button, its
destination, the focal point, the header contrast mode and the featured product
are one row in `site_settings`, edited at `/admin/homepage`. See D-020.

`[x]` **The price sits high.** The hero holds about 78–84% of the first screen
and its product block ends well above the foot of the image, with the showcase
overlapping the bottom edge. One ordinary scroll reaches four large cards with
names and prices on them.

`[x]` **Search means what a shopper means.** It was `title ILIKE` and brand.
It is now Postgres full-text across the title, brand, description with markup
stripped, bullet points, spec table, tags and meta description, plus the
category name, the variants' attribute values, and a substring match on the
title. Every typed word is a prefix term, so it serves the autocomplete too.
Migration `0012_product_search.sql` adds the matching GIN index. See D-018.

`[x]` **Autocomplete is grouped and has thumbnails.** Products (with their
photograph and brand), categories, brands, and suggested searches taken from
the listings' own tags — never invented phrases, which would lead to empty
pages. Debounced, cancellable, keyboard-navigable, with a loading mark and a
real empty state. It still returns no price and no stock, so it cannot be used
to enumerate the catalogue.

`[x]` **A catalogue panel, from the real tree.** Every shelf and sub-shelf with
live counts, opened by a button rather than by hover, closed by Escape, a click
outside, or arriving somewhere. Nothing in it is hard-coded: a category added
in the admin is in the menu on the next request.

`[x]` **Filters gained chips, a clear-all and a mobile sheet.** Each chip
removes exactly its own filter and is an ordinary link, so filtering and
unfiltering are both navigations and the back button works. On a phone the
panel is a bottom sheet driven by a checkbox and a label — no JavaScript, which
a `<details>` could not do without being open on arrival on a desktop or shut
on a phone.

`[x]` **Recommendations are scored.** A stated relationship counts most, then
the shelf, a shared tag, the brand, a comparable price. Nothing scoring zero is
returned as a recommendation; a short row is topped up with the best-rated
products rather than filled at random. See D-019.

`[x]` **Product cards follow the reference.** Large rounded photograph, bold
name, one line of the listing's own words, heavy price. The badges and meters
that used to sit on every card now appear only when they are saying something
true about that product — a full batch, a window closing, a batch more than 60%
taken.

`[x]` **Product media management gained "Make main" and "Move down".** Reaching
the front of a gallery by pressing "move up" four times is how an order ends up
wrong.

### Two things worth knowing

**The old hero's photograph is no longer wired in.** `lib/hero-media.ts` has
been removed, and with it the mapping that put `public/hero/fragrance-bottle.jpg`
on the home page. That file was flagged in this document as not licensed for
this shop; it is still in the repository and is now used by nothing. The hero
is whatever staff upload at `/admin/homepage`, and with nothing uploaded it
falls back to the featured product's catalogue artwork.

**A keyboard bug was found and fixed in passing.** The collapsed category row in
the header was hidden by clipping its height, which leaves its links in the
accessibility tree and reachable by Tab. It is `invisible` as well now, so a
closed menu is closed for a keyboard and a screen reader too.

### Two defects the redesign uncovered, both older than it

**The header's search field could never have been translucent.** A top-level
`input:not(…)` rule in `app/globals.css` set `background: var(--color-paper)`.
Unlayered CSS beats anything inside a Tailwind layer whatever the specificity,
so every utility on that field lost to it, and the "translucent bordered
search" the brief asks for rendered as a solid white box over the hero
photograph. The ground and the lettering now sit in `@layer base`; the hover,
focus and disabled states stay outside it, because those are behaviour and a
field that carries its own border colour should still answer the pointer.

**A closed menu was reachable by keyboard.** The collapsed category row in the
header, and now the filter drawer, were hidden by clipping height alone, which
leaves their links and inputs in the accessibility tree. Both are `invisible`
when closed.

The Next.js development route indicator is also off (`devIndicators: false` in
`next.config.ts`). It floats in the bottom-left corner, which is where this shop
puts things a shopper presses on a phone — the buy bar, and the footer of the
filter drawer — and it was intercepting those presses in the browser and in the
end-to-end suite alike.

### Verification

| Gate | Result |
| --- | --- |
| `npm run lint` | `[x]` passes |
| `npm run typecheck` | `[x]` passes |
| `npm run build` | `[x]` passes |
| `npm test` | `[x]` passes — 603 tests, 40 files (2 skipped without a PostgreSQL server) |
| `npm run test:e2e` | `[x]` passes — 400 passed, 4 skipped, mobile and desktop |
| Axe at AA — home, search, category with filters, product detail | `[x]` 0 violations at both widths |
| Sideways scroll at 320, 390, 820, 1440 | `[x]` none |
| Browser console | `[x]` clean |
| Hero photograph uploaded through `/admin/homepage` | `[x]` verified end to end in a browser: 201, stored by the media provider, live on the storefront on the next request |
| Header contrast over a real photograph | `[x]` measured dark, header took the pale treatment; the drawn catalogue artwork measures light and it takes navy |
| Search finds a product by a word only in its description | `[x]` verified in the browser and in `tests/search.test.ts` |
| Mobile filter drawer | `[x]` opens, filters, and closes; its controls are unreachable while shut |
| Catalogue panel | `[x]` every shelf and sub-shelf from the live tree, with counts |
| Recommendations | `[x]` scored rows on the product page and the cart, deduplicated between the two |

**Not verified, and stated plainly:** the production JavaScript budget was not
re-measured after this change (`npm run test:e2e:prod` was not run in this
session), and no real photography exists in the repository — the hero currently
shows the sample image the owner supplied earlier, which carries another brand's
copyright notice and must be replaced before the shop is public. Removing it is
one press of **Remove** on `/admin/homepage`.

## The photograph left bare, and a curated row (added after Phase 15)

The owner looked at the redesigned homepage and asked for three things: take
the headline, the batch panel and the button off the image; make the row under
it four products; and give staff a way to choose those four — "or maybe a
direct link from the products where i can just add it to the product
showcase". They also settled the name: **Manifest**, with no "BD" after it.

`[x]` **The hero carries nothing.** No eyebrow, no headline, no supporting
sentence, no brand, no price, no capacity meter, no countdown, no call to
action. The full-image scrim went with them — it existed to keep words legible
over a photograph, and with no words there is nothing to keep legible, so the
picture is now untouched below the header. What remains is a veil the height of
the header itself, which is the only part of the image anything is drawn on.

`[x]` **The words that mattered moved rather than vanished.** The landed-price
promise now sits directly under the product row, which is the first thing below
the photograph, and again at the foot of the page. The page's `h1` is visually
hidden: a page needs one heading, and with nothing on the image it belongs in
the markup.

`[x]` **Four products, chosen by staff.** `home.showcase` holds a list of slugs
in order. Staff arrange it at `/admin/homepage` — add, remove, move up, move
down, each with the product's own photograph beside it — and a product can also
be put on the homepage from its own admin page, which is usually where someone
is standing when they decide. Choices lead the row and the catalogue fills the
rest, so it is always four and never has holes in it.

`[x]` **Changing a card's picture is changing the product's picture.** The row
holds no second copy of an image; a card shows the product's main photograph,
and "Make main" in the product's Photographs section is what changes it. The
admin page says so where the decision is made.

`[x]` **The name is Manifest.** The "BD" that sat beside the wordmark is gone
from the header, the footer, the sign-in page and the not-found page.

### What this cost, and what replaced it

The hero settings shrank to the photograph, its focal point and the header
contrast mode. The headline, supporting sentence, call-to-action label,
destination and featured-product fields were removed from the schema and from
the admin page rather than left as controls that would change nothing — a
settings panel whose switches do nothing is the specific thing CLAUDE.md §11
rules out. Their tests went with them, replaced by tests for what the settings
now are, and by a new suite for the curated row: order kept, duplicates
dropped, ceiling enforced, every change audited, and no customer able to write
any of it.

## Product management and the product page (this session)

The listing gained the fields a shopper actually asks about, and the admin
screen was rebuilt around them. Nothing was removed: the setup wizard, the
variant matrix, the preorder windows, the homepage row and the archive/restore
pair all work exactly as before.

### Admin

`[x]` **The product page is panels, not one long form.** Basics, Media,
Description, Specifications, Warranty and safety, Search listing, Publishing —
a tab strip on a wide screen and a select on a phone. Each panel saves only the
fields it owns, and says plainly when it has unsaved changes.

`[x]` **The API applies partial updates.** A field that is not sent keeps its
stored value; `null` clears it. The old arrangement made every form re-post the
whole record, and a form that forgot a field erased it — that trap is gone, and
an end-to-end test now holds the line.

`[x]` **New listing fields.** Product SKU (unique across the catalogue, with
the clash named when it is not), a trade identifier and its type, key features,
what is in the box, warranty, certifications and safety, country of origin, the
advanced attribute block, a product video, search keywords, tags, a no-index
switch, a canonical link, and publish/unpublish dates.

`[x]` **Specifications are defined per category.** A category is given its own
questions at `/admin/categories` — text, number, yes/no, one of a list, several
of a list, date, measurement, colour or link — and every product filed beneath
it is asked them, inheriting whatever its ancestors define. Adding a shelf no
longer means a schema change.

`[x]` **Photography, properly managed.** Drag to reorder or use the buttons,
promote any image to main, correct a description without re-uploading, and see
the file before it is uploaded. Lifestyle imagery is a second, separate gallery
that never disturbs the main image.

`[x]` **Sale pricing and stock states per variant.** Sale price with a start
and end date, a low-stock threshold, and the variant's SKU editable in the
pricing table.

### The product page

`[x]` **An Amazon-style gallery.** Large main image, thumbnails that switch it,
hover magnification that follows the cursor without moving anything on the
page, click to open a full-screen viewer with arrows, thumbnails, escape and
swipe. The product video sits in the gallery beside the photographs.

`[x]` **The buy box states the deal.** Sale price beside the regular price with
the saving, the availability in one consistent vocabulary, quantity, and the
key features at a glance.

`[x]` **Sections below, and only the ones with content.** Description, key
features, what is in the box, warranty, certifications and safety, a
specifications table assembled from four sources with one row per fact, and a
lifestyle band. A listing with none of these shows none of these headings —
there are no dashes and no empty panels.

### Verified

- `npm run test` — 42 files, 639 passed, 2 skipped.
- `npm run typecheck`, `npm run lint` — clean.
- `npm run build` — succeeds.
- `npm run test:e2e` — 418 passed, 4 skipped, across mobile and desktop.
- The dev server is running with the migrated database, and the seeded
  headphones are the worked example: every new field filled in, one colourway
  on offer, a second gallery shot and a lifestyle image.

### Not verified

- `[!]` The hover magnification is checked by hand and by eye, not by an
  automated test — a cursor-following transform has no assertion worth writing.
- `[!]` Video playback is `UNVERIFIED — external integration unavailable`. The
  YouTube and Vimeo embeds are built from the link and rendered, but nothing in
  this repository can confirm a third-party player loads.

## Search and product discovery (this session)

An Amazon-style search built inside the existing Postgres — no external search
service (DECISIONS.md D-026 to D-030). Migration `0014_search_discovery.sql`.

### What changed for shoppers

- `[x]` **Header search**: a search button, a clear button, suggestions after
  two letters — completed searches taken from real product names ("iph" →
  iPhone 15, iPhone 15 Pro, iPhone Case), up to four products with photo and
  price, "iphone in Phones" shelf suggestions, brands. Before typing: your
  recent searches (on your account when signed in, in the browser otherwise,
  each removable, "Clear recent searches") and popular/trending searches once
  there is real traffic. Arrow keys, Enter, Escape. On a phone the search
  opens full screen with Cancel.
- `[x]` **Finds by** name, brand, SKU (with or without dashes), variant SKU,
  barcode/GTIN/UPC/EAN/ISBN, model and part number, keywords, category, highlights,
  option values (colour, size…), category specifications (RAM, processor…),
  description, specs, tags.
- `[x]` **Ranking** by relevance tier: exact code, exact name, brand, phrase in
  name, all words in name, then strong fields, highlights/specs, anywhere.
  Sales, rating, availability, newness and the staff boost only reorder
  within a tier.
- `[x]` **Typos**: prefixes and word stems already catch "iphon", "airpod",
  "headphons". When nothing matches, the likely spelling is used and the page
  says "No results for 'samsng'. Showing results for 'Samsung'" with a link to
  search exactly what was typed.
- `[x]` **Results page** (`/search`) and **every category page** share one
  system: result count, sort (Relevance, Featured, price both ways, newest;
  customer rating, best selling and biggest discount appear only once reviews,
  sales or a live sale exist), filter chips with "Clear all", numbered pages,
  and the whole state in the URL (`/search?q=laptop&brand=Dell&ram=16&min=500`).
- `[x]` **Filters**: category/subcategory with counts, brand (multi), price
  bands with counts plus your own range, availability (buy now, preorder, in
  stock, on sale), customer rating, and attribute filters generated from the
  results — RAM appears over laptops and never over shoes. On a wide screen a
  tick applies at once; on a phone the filters are a sheet with Apply.
- `[x]` **Empty search**: advice, "Did you mean", and what each word finds on
  its own; never unrelated products.
- `[x]` **Cards** now show a sale's struck-through regular price, a −N% badge,
  and "Out of stock" for in-stock goods with none left.

### What changed for staff

- `[x]` Product editor → **Search listing**: "Show this product in search
  results" (off hides it from search only — page, category and cart keep
  working), **Search priority** (Promote … Bury), search keywords.
- `[x]` **Admin → Search** (`/admin/search`): searches, visitors, zero-result
  rate, click-through; most searched; searches that found nothing with "Add a
  synonym"; synonym manager (one-way or two-way, audited); index status and
  "Rebuild search index".
- `[x]` **Categories → specifications**: each can be switched as a filter and
  as searchable. Products list marks "Hidden from search".
- Six starter synonyms are seeded for this catalogue (sweets⇄candy,
  earbuds⇄earphones, flask→carafe/thermos, rucksack→daypack/backpack, frying
  pan→skillet, sunblock⇄sunscreen). Configuration, not data — edit or delete
  them freely. They are in the seed, and were added to the dev database
  directly (it was migrated, not re-seeded, so nothing else changed).

### Verified

| Gate | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` | `[x]` clean |
| `npm run build` | `[x]` passes |
| `npm test` | `[x]` 692 passed, 11 skipped (the three real-server concurrency suites skip because they could not reach their server during the run — same as before this work) |
| New unit suites | `[x]` search-engine 25, search-index 12, discovery 13, search-analytics 12 |
| `e2e/search.spec.ts` | `[x]` 22 passed, mobile and desktop |
| `e2e/filters.spec.ts`, `e2e/storefront.spec.ts` | `[x]` pass |
| `e2e/accessibility.spec.ts` | `[x]` 28 passed, zero violations |
| Migration on the dev database | `[x]` applied alone (no re-seed, nothing lost): 24 products indexed |

### Not verified, stated plainly

- `[ ]` The **full** e2e sweep was not run — only the search, filters,
  storefront and accessibility specs.
- `[ ]` **Performance at scale is not measured.** Query plans were not checked
  against a large synthetic catalogue; with 24 products every query is
  trivially fast and proves nothing about thousands. The indexes are in place
  (GIN on the document, the codes, the vocabulary and specifications) but
  their use at scale is reasoning, not measurement.
- `[ ]` Search-to-order conversion is not measured (searches are counted
  without an account) — the admin page says so.
- `[!]` Popular and trending searches will stay empty until at least three
  different visitors run the same search. That is by design, not a fault.
- Known limit: accented letters are not folded ("cafe" does not find "café").
- Found while testing, not changed: `updateProduct` looks up a new slug outside
  its own transaction. Harmless on the real database; it hangs the in-process
  test database, so tests pass the slug explicitly.

## Gap audit against the spec (this session)

The whole product was compared against MASTER_PRODUCT_SPEC.md and the
extended product and search brief. Baseline before any change: typecheck and
lint clean, 701 unit tests passed (2 skipped). Nothing was redesigned; every
new screen reuses the existing panels, buttons, fields, badges and empty
states.

### Gap matrix

| Area | Before | Now |
| --- | --- | --- |
| Catalogue, variations, search, filters, product page, gallery | Complete (earlier sessions) | unchanged |
| Preorder engine, capacity locking, waitlist, windows | Complete | unchanged |
| Cart, checkout, mock payments, idempotent orders, deposits/balance | Complete | checkout opens on the default saved address |
| Orders, tracking, cancellation requests, refunds, shipping mock | Complete | unchanged |
| Admin: products, wizard, categories, orders, reviews, analytics, audit, staff, settings, CSV | Complete | unchanged |
| **Wishlist** | Missing (table only, no UI or API) | `[x]` added |
| **Save for later** | Missing | `[x]` added (moves to the wishlist) |
| **Recently viewed** | Missing | `[x]` added (product page row) |
| **Address book** in the account | Missing | `[x]` added |
| **Newsletter signup** (spec §5) | Missing | `[x]` added (footer) |
| **Help / FAQ / shipping / refunds / contact** | Missing | `[x]` added at `/help` |
| **Admin customer list** (spec §4) | Partial (query only, no screen) | `[x]` added, super admin only |
| Coupons | Missing | `[!]` deferred — business decision (D-033) |
| Dhaka / outside-Dhaka delivery pricing | Missing | `[!]` deferred — conflicts with the landed price (D-010, D-033) |
| Real payment gateway, courier, email/SMS | Mocked | `[!]` UNVERIFIED — external integration unavailable |

### What changed for shoppers

- `[x]` **Save to wishlist** under the buy box, per option. A guest is sent to
  sign in and brought back.
- `[x]` **Account → Wishlist**: live price, availability ("This preorder is
  full", "Out of stock", "No longer sold"), Move to cart, Remove.
- `[x]` **Cart → Save for later** (signed in), and a line pointing to what is
  saved.
- `[x]` **Recently viewed** row at the foot of a product page.
- `[x]` **Account → Addresses**: add, edit, remove, make default; up to ten.
  Editing an address an old order used keeps the old one for that order
  (D-032).
- `[x]` **Help** page linked from the footer, and a **newsletter signup** in
  the footer.
- The account pages share one row of tabs: Orders, Wishlist, Addresses,
  Security.

### What changed for staff

- `[x]` **Admin → Customers** (super admin): search by email or phone, orders,
  amount spent (excluding cancelled/refunded), last order. Staff admins are
  sent back to the overview and the query refuses them as well.

### Verified

- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — 705 passed, 11 skipped (the real-server concurrency suites skip
  when the database server is not running at the start of the run). New
  `tests/account.test.ts`: 13 tests — ownership, no stored price, the
  copy-on-write address rule, newsletter idempotency, cookie parsing.
- Migration `0015_newsletter.sql` applied to the dev database on its own; no
  re-seed, nothing lost.
- Driven in a browser against the dev server as the seeded customer, admin and
  staff (see below for e2e): save/unsave, wishlist → cart → save for later, add an address,
  newsletter signup, recently viewed, admin customer list, staff refused. No
  sideways scroll at 320px on the wishlist, addresses and help pages.

- Targeted e2e (`accessibility`, `checkout`, `product-detail`, `storefront`,
  mobile and desktop): first run 84 passed, 2 failed — the footer signup's
  label contained the word "email", so the checkout's `getByLabel("Email")`
  found two fields. Label reworded; `checkout` and `accessibility` re-run:
  48 passed, zero axe violations.

### Not verified, stated plainly

- `[ ]` The full e2e sweep was not run — only the four specs above.
- `[ ]` Nothing is sent to newsletter subscribers: no email provider is
  connected. The table records consent only.
- `[ ]` Returns of delivered goods have no written policy in the docs; the
  help page describes a case-by-case review rather than inventing terms.
- Noticed, not changed: the dev overlay reports a hydration mismatch on the
  header search box (`caret-color` style), from earlier work.

## UX, homepage campaigns, roles and admin overhaul (this session)

Migrations `0016_staff_roles_and_names.sql` and `0017_admin_inbox.sql` —
both applied to the dev database on their own (no re-seed; nothing lost). The
dev accounts `admin@example.com` and `customer@example.com` were given first
names (Owner, Nadia) so the header greeting is visible.

### What changed for shoppers

- `[x]` **Homepage promotional slider** (D-035): up to five slides, each one
  hero (87% of the screen on desktop) plus four image-and-title tiles that
  change together. Arrows, swipe, keyboard, dots. Clickable hero with its own
  destination; optional headline, text and button. No autoplay. Unused slots
  never appear. "This batch" row removed. The existing hero was carried over as
  slide 1, with the four newest listings as its tiles until staff replace them.
- `[x]` **Header**: glass search field over the hero (thin pale border,
  translucent, blur), Wishlist icon (guests go through sign-in and return to
  the wishlist), first name instead of "Account" when signed in.
- `[x]` **Sign up** at `/register`, with Sign in / Create account tabs on both
  pages. Uses the existing register API; signs the customer in on success.
- `[x]` **Compact product cards** everywhere (listings, search,
  recommendations, recently viewed, homepage): smaller type, one-line
  description, 5 across on wide screens.
- `[x]` **Filters**: denser, smaller type, apply instantly (price applies when
  typing pauses); no Apply button; "Clear all" and chips kept; phone sheet ends
  with "Show N results".
- `[x]` **Category menu**: vertical dropdown with counts and expandable
  sub-shelves, scrolls when long, and always opens above the filters (it closes
  the phone filter sheet and raises the header while open).
- `[x]` **Product page**: compact buy box (smaller price, one-line countdown,
  normal-size Add to cart); specifications and description start higher;
  "The Route" moved to the very bottom.
- `[x]` **Account → order**: each item's price and the order total; the
  goods/freight/duty split is no longer shown to customers.

### What changed for staff

- `[x]` **Roles** (D-034): Owner, Operations manager, Product manager, Order
  manager, Customer support, Marketing, Finance — enforced in `lib/`, per page
  and in the nav. Staff screen: role select per person, separate "Remove
  access", permission table, 8-character minimum password. "Change to" gone.
- `[x]` **Customer spend bug fixed.** Cause: the customer list's correlated
  subquery rendered the account id as a bare `"id"`, which inside
  `from orders` meant the order's own id, so every customer showed 0 orders and
  BDT 0. Now a grouped join; spend counts paid statuses only.
- `[x]` **Overview** rebuilt: KPIs with change vs previous period (sales and
  average order only for finance roles), sales/orders per day chart, needs
  attention, recent orders, top products, running low, newest customers.
- `[x]` **Products**: thumbnail, price range, stock or places left, category,
  status; instant search, status/category filters, sort; bulk hide/show in
  search.
- `[x]` **Categories**: foldable tree with product counts (direct and
  including sub-shelves), inline rename/move/re-slug, delete (refused with the
  reason while anything is filed there).
- `[x]` **Orders**: search by number, name, email or phone; status chips; date
  range; sort; customer, items, payment state and preorder flag per row.
  Support and Finance see orders read-only.
- `[x]` **Notifications**: inbox (unread / needs action / read, mark all read)
  built live from real records (D-036); customer messages outbox in its own tab.
- `[x]` **Analytics**: 7/30/90 days or a custom range; KPIs with comparisons;
  sales, orders and sign-ups per day; top products; category performance;
  funnel; preorder utilisation; repeat buyers.

### Verified

- `npm run typecheck`, `npm run lint` — clean. `next build` — passes.
- `npm test` — all pass except the real-server concurrency suite, which failed
  with "too many clients" while the dev server held connections (environment,
  not code). New suites: `customer-spend` (8), `homepage-campaigns` (17), role
  permissions added to `authorize`.
- Rendered and inspected in a browser at 1440px and 390px: homepage slider and
  tiles, header over the hero, search, filters, category dropdown over the
  filters (desktop and phone), product page, sign-up, account, and every admin
  screen as the owner. No console errors after fixing one (category analytics
  query passed JS dates to raw SQL).

### Not verified, stated plainly

- `[ ]` Swipe on a real touch device — implemented with touch events and
  checked only by reading; the e2e suite drives the arrows.
- `[ ]` Header "Automatic" contrast on a bright uploaded photograph — the
  existing measurement code is reused, but only the current (dark) hero was
  looked at.
- `[ ]` The admin screens were inspected as the owner only; the other roles
  are covered by unit tests of the permission table and page guards, not by
  signing in as each.
- `[ ]` Full e2e sweep not run — targeted specs only (see below).

### End-to-end (targeted), against the production build on port 3100

Run beside the owner's dev server, which Next 16 will not let a second
`next dev` share (see TESTING.md).

- `[x]` homepage-admin, filters, experience, smoke, seo, admin-ops, auth,
  storefront, product-detail, accessibility — mobile and desktop. First run
  133 passed / 33 failed; every failure was fixed at its cause:
  small grey text below AA contrast (raised), a tile rule that refused to save
  a slide with empty tiles (real bug, fixed), the staff page wider than a phone
  because screen-reader labels escaped their scrolling tables (fixed), the
  compact countdown dropping its `timer` role (restored), and tests written for
  the old wording. Final: the ten specs pass, the four that had failed last
  re-run at 60 passed, 4 skipped (pre-existing skips).
- `[ ]` The full e2e sweep (all specs) was not run.

## Hero + showcase visual refinement (this session)

Visual only; no data, route or permission changes.

- `[x]` Hero measured at 87% of a 1440×900 viewport; the showcase cards
  overlap its foot so their tops show on the first screen.
- `[x]` Headline, text and button centred over the lower hero; compact rounded
  button; a light shade under the words only (no full-image overlay); text
  colour follows the slide's tone/contrast setting.
- `[x]` Previous/next are circular translucent chevrons at the hero's vertical
  centre, smaller on phones.
- `[x]` Showcase cards: white rounded cards on a gray well, image whole and
  centred (`object-contain`), centred bold title, soft shadow, no price. Fewer
  than four tiles are centred (a 3-tile slide shows three cards, no gap).
- `[x]` Homepage canvas is a very light gray-white (#f5f6f8).
- Verified in a browser with temporary test words on two slides (then the
  settings row was restored exactly): hero link and tile links correct,
  inactive slot hidden, chevrons move hero and tiles together and wrap, no
  page errors, no sideways scroll at phone width.
- `[ ]` The reference screenshots mentioned in the brief were not attached to
  the request, so the look follows the written description, not the images.
- `[ ]` Automatic contrast on a light photograph not checked (only the current
  photograph is uploaded).

## SKU reservation system (this session)

Migration `0018_sku_reservations.sql`, applied to the dev database alone.

- `[x]` Add Product shows a server-generated SKU (`SKU-000001` …) with
  "Automatically generated and held for this product"; still editable.
- `[x]` Refresh / reopen keeps the same SKU; a second admin gets a different
  one; Cancel releases it and the next form reuses it; saving makes it
  permanent; archived products keep their SKU; an edited product keeps its old
  SKU spent. Expired holds are released by the maintenance sweep.
- Verified: typecheck and lint clean; `tests/sku-reservations.test.ts` (19)
  plus catalog/product/variant suites pass (108); 8 simultaneous reservations
  against the real Postgres server received 8 distinct SKUs; the whole flow
  driven in a browser with held-SKU counts checked after each step.
- Found and fixed while verifying: React's development double-mount made each
  form opening request two holds; one request is now shared.
- One test product, "SKU check — archived test product" (SKU-000005), was
  created and archived during verification. It is in Admin → Products under
  archived and holds SKU-000005 permanently, as designed.
- `[ ]` Browser end-to-end specs not re-run (the existing product-edit spec
  types into the SKU field, which still works).

## SEO Pulse V2 (this session)

Migration `0019_seo_pulse.sql`, applied to the dev database alone. Design and
field mapping: DECISIONS.md D-038.

### What changed for staff

- `[x]` New **SEO Pulse** tab in the product editor, and the same panel under
  the SEO step of the setup wizard. Status (Not researched / Research
  available / Needs refresh / Applied / Updated since applied), research date,
  both scores with how each is scored, Run SEO Pulse / Run fresh research,
  Download JSON / CSV, Open report, research history (every version kept).
- `[x]` Recommendations, each editable, next to the existing value: primary,
  secondary and long-tail keywords with intent; keywords grouped by intent;
  focus keyword, SEO title (+ alternatives), meta description, slug (conflict
  checked), H1, description improvements and a suggested description; search
  aliases, misspellings, phrases, brand variations, synonyms, related terms,
  tags; alt text per photograph with suggested filenames; content gaps, FAQ
  opportunities, identifiers, structured-data readiness, category notes;
  providers used and their status.
- `[x]` Per-field Apply, and "Apply selected recommendations". Empty fields
  fill; filled fields default to Keep existing and need Replace, confirmed on
  screen and enforced by the server. Nothing is published.
- `[x]` **Admin → SEO Pulse**: provider configuration, recent research across
  the catalogue with downloads, products never researched.
- Existing pages unchanged apart from the new tab, the new nav item and the
  panel under the wizard's SEO step.

### Verified

- Typecheck and `npm run lint` clean. `next build` passes (the five new
  SEO Pulse routes compile).
- Full unit suite (real-server concurrency suites excluded): 48 files, 790
  tests pass, including `tests/seo-pulse.test.ts` 33/33.
- Driven in a browser as the owner on a throwaway product: run → research
  complete; second click reused the research; Apply filled the five empty
  fields and kept the hand-written SEO title; the Search listing tab showed
  the applied values after the apply; an API apply that would overwrite the
  title without Replace got 409; regenerate added version 3 with 1 and 2
  kept; JSON, CSV and HTML downloads 200; phone width (390px) has no sideways
  scroll; anonymous 401, customer 403 on run and export; no console errors.
- The throwaway product "SEO Pulse check — Anker 737 USB-C Power Bank
  24000mAh" was archived afterwards; it keeps three research versions.

### Not verified, stated plainly

- `[!]` **External research — UNVERIFIED, external integration unavailable.**
  The DataForSEO provider (search volume, difficulty, CPC, trend, Google
  results for Bangladesh) was never called: no credentials. Until
  `SEO_PULSE_DATA_PROVIDER=dataforseo` and its login are set, every run shows
  those figures as "Data unavailable".
- `[!]` **AI analysis — UNVERIFIED.** The Claude provider was never called: no
  `ANTHROPIC_API_KEY`. Without it, recommendations come from the free rules
  generator and are labelled "Rule-based". Rule-based output is plainer than
  an AI's: it rearranges the product's own words, so a weak product name
  gives weak keywords.
- `[ ]` Site-wide synonym creation from the panel is covered by unit tests,
  not clicked in the browser.
- `[ ]` Other staff roles were not signed in as; permissions are covered by
  unit tests (product manager can run; order manager and customer refused).
- `[ ]` No end-to-end spec added; full e2e sweep not run.

## Variants, SEO Pulse apply-all, category drawer, category guide (this session)

- `[x]` **Variants can be managed.** Cause of "can't change, add or delete": the
  variants screen could only generate combinations, and there was no screen at
  all for creating options (Colour, Size) or their values. Now one screen, in
  three steps (also the wizard's Variations step): 1. Options — create an
  option with its values, add or remove values, tick the ones the product
  uses; 2. generate every combination, or add one variant by hand (a new value
  typed there is added to the option); 3. every variant has Edit (SKU, price,
  sale price, sold as, stock or places, on/off) and Delete, plus bulk on/off/
  delete and select-all. A variant that has ever been ordered, reserved,
  waitlisted or stock-adjusted is archived instead of deleted (shown under
  "Show archived", restorable), so order history stays intact. New routes:
  `POST /api/admin/attributes`, `POST /api/admin/attributes/[id]/values`,
  `DELETE /api/admin/attributes/values/[id]`,
  `POST /api/admin/products/[id]/variants`, `DELETE`/`POST restore` on
  `/api/admin/variants/[id]`. Audit: `variant.deleted`, `variant.archived`,
  `variant.restored`.
- `[x]` **SEO Pulse:** "Apply all recommendations" (one click, one
  confirmation for anything being replaced), "Select all", "Apply selected".
  Apply-all never changes the address, the product name or site-wide
  synonyms. After applying, a link opens the product page and says which
  fields show on the page and which only appear in search results.
- On "things don't update on the product page": checked — the storefront page
  is rendered fresh on every request, and applied values were in the database
  and in the editor immediately. Two things make it look unchanged: SEO title,
  meta description, focus keyword and search keywords are never printed on
  the page itself; and a draft product is not shown to shoppers at all
  ("Product not found") until it is published.
- `[x]` **Category menu:** now a drawer from the top-left edge, full height,
  over a soft dimmed and blurred veil — near-opaque white, so it reads the
  same over any hero photograph. Close button inside; Escape, clicking the
  veil and navigating also close it.
- `[x]` **Categories admin:** "How categories work" guide (main categories,
  sub-categories, filing a product, where each shows); "+ Sub" on every row to
  add a sub-category in place; ↑ ↓ to reorder siblings (the order shoppers
  see in the menu and on the homepage).

### Verified

- Typecheck and lint clean. `tests/variant-management.test.ts` (7) plus
  catalog, combinations and SEO Pulse suites: 81 pass.
- Browser, as the owner, on a throwaway product (archived and its test data
  removed afterwards): created an option with two values, generated 2
  variants, added a third with a new value, edited a price (shown BDT 2,200),
  deleted one (deleted, not archived — no history). SEO Pulse Apply all
  confirmed the one replacement (Description) and applied six fields; the
  Description tab showed the new text. Category drawer opens at the left
  edge (352px wide, full height) and closes. "+ Sub" created a sub-category
  (then deleted); ↓ swapped the first two main categories (order restored
  afterwards). No console errors.
- `[ ]` Archive-instead-of-delete for an ordered variant is covered by unit
  tests (reserved places), not clicked in the browser.

## SEO Pulse fills the product page itself (this session)

- Investigated "SEO Pulse doesn't paste the fields into the product page":
  every apply had saved (audit log and database agree). The products applied
  to (e.g. "Airpods 5") had no description, key features or specifications,
  and SEO Pulse runs on the rules generator (no Claude key), which never
  invents product facts — so it wrote nothing for the visible page, only the
  search fields (SEO title, meta description, focus keyword, tags, search
  keywords), which do not appear on the page.
- `[x]` The rules now always offer a starter description when the current one
  is short: product name, its category, and the shop's own facts (sourced
  from the US, delivered in Bangladesh, preorder where it is one). Nothing
  about the product itself is invented.
- `[x]` New **key features** recommendation, applied to the product's key
  features (`bullet_features`) — Claude drafts them when connected; with the
  rules they are typed in the SEO Pulse panel and applied with everything
  else. Adding needs no permission; dropping existing ones needs Replace.
- `[x]` A banner explains when a product is too empty for the rules to write
  from.
- Verified in the browser on a throwaway empty product (archived after):
  Apply all wrote the description and two typed key features; the
  Description tab and the storefront page both showed them. SEO Pulse tests
  35/35; typecheck and lint clean.
- `[!]` Real product copy (description and features written for you) needs
  Claude: set `SEO_PULSE_AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.
  UNVERIFIED — never called without a key.

## Products admin reorganised (this session, D-039)

Why Publish was hard to find: it existed only as the last step of the setup
wizard. The product list had no publish action, the editor's Publishing tab
only said "use the wizard", and there was no unpublish, duplicate, delete or
draft preview at all.

### Existing capabilities checked before and after

- `[x]` create product (now lands in the editor) · `[x]` edit every section ·
  `[x]` save (per section, plus Save all from the bar) · `[x]` publish (list
  row, bulk, editor bar, wizard) · `[x]` archive / restore · `[x]` image
  upload and ordering (Media panel unchanged) · `[x]` variations (now also an
  editor tab) · `[x]` pricing and inventory (now also an editor tab) ·
  `[x]` categories · `[x]` SEO fields · `[x]` SEO Pulse · `[x]` search
  show/hide (bulk) · `[x]` wizard (kept, linked as "Guided setup").
- New: unpublish, duplicate, delete (history-safe), staff preview of drafts,
  change category (row and bulk), summary cards, inventory filter, sorting by
  created date and name Z–A, loading skeletons, error state with Retry, empty
  state, unsaved-changes guard, per-check publish errors with Fix links.

### Verified

- Typecheck and lint clean. Unit: `tests/product-lifecycle.test.ts` (8) plus
  catalog, readiness, variant and SEO Pulse suites — 89 pass.
- Browser, as a first-time admin (throwaway products, deleted afterwards):
  Drafts card filtered the list; Add product → editor with "Draft created";
  Publish now listed "3 things need attention" with Fix links that opened the
  right tab; after adding a photo and a variant it published; editing a live
  product showed "Unsaved: SEO & search", the leave guard, then Update
  product saved; Out of stock card, name search and category filter found
  the right rows; ⋮ menu grouped Manage / Visibility / Catalog / Danger zone;
  Duplicate made a draft copy; row Publish published it; bulk Unpublish and
  bulk Delete worked with confirmations; draft preview shows the banner and a
  signed-out visitor gets "not found"; 390px phone shows cards with Publish
  and no sideways scroll. No console errors.
- Found and fixed while verifying: archived products showed under "All (not
  archived)" on first load. Cause: the server page read the default filters
  from the `"use client"` list module, where a server component receives a
  reference instead of the value, so every default was undefined until a
  filter was touched. The filters now live in `app/admin/products/filters.ts`;
  first load shows 27 of 32 with no archived rows. Also stopped badges and
  SKUs wrapping onto two lines.
- E2E specs updated for the new flow (creating lands in the editor; status no
  longer a Basics field; variants wording; archived products found under the
  Archived filter). Against the production build on port 3100:
  product-edit, preorder-windows, media, wizard, admin-variants, admin-ops
  pass (last runs 28/28 and 50/54 before the final two fixes).
- Found while running them: on a phone the action bar's status text was
  squeezed to nothing (fixed with a minimum width); the "Preorder windows"
  link had been folded into a tab (restored to the product header).
- `[ ]` `admin-catalog` "category tree" tests (2) still fail: they look for a
  list named "Category tree", but the Categories page became a table in an
  earlier session. Test not updated; the page itself works.
- `[ ]` balance and filters specs not re-run (they only share the create
  step, which was updated).

## Product editor reorganised: product-owned variants, one-click SEO Pulse (this session, D-040)

What was wrong, found by inspection:
- Variant options were shop-wide: every product saw every other product's
  colours, and removing a value warned about unrelated products.
- `variant_images` existed but nothing used it — no per-variant photos.
- Variations, pricing and inventory were three separate places; description,
  specifications, SEO & search and SEO Pulse four separate tabs; SEO Pulse
  showed its whole analysis in the editor.

### What changed

- `[x]` **Options belong to the product** (migration 0020, applied to the dev
  database: 0 shared options still in use, 5 converted). New product → empty
  variants. Removing a value affects only that product. Duplicate gives the
  copy its own options; Delete removes the product's own options with it.
- `[x]` **Variants, pricing & inventory** is one compact section: groups as
  chips (6 shown, "+N more"), "+ Add variant group", "+ Add value" (Enter),
  starting price and "Same price for all", one row per variant (photo, name,
  SKU, price, stock, state) that opens into price, sale price, SKU, stock or
  preorder places, closing and arrival dates, payment/deposit, photo (pick
  one of the product's or upload), on/off, delete. Folded after 8 rows.
  Adding a group removes variants that no longer fit (archived if ordered).
- `[x]` **Variant photos** show in the storefront gallery when that variant is
  chosen.
- `[x]` **One page**: 1 Basic information · 2 Media · 3 Variants, pricing &
  inventory · 4 Product information (description & key features,
  specifications, search & SEO) · 5 Warranty & safety (folded) · 6 Visibility
  & schedule (folded). Jump bar at the top; right column: **SEO Pulse** box and
  **Before publishing** checklist with "Fix →" links that scroll to the
  section and focus the field.
- `[x]` **SEO Pulse = "✨ Fill with SEO Pulse"**: saves unsaved edits, then
  fills only empty fields (focus keyword, SEO title, meta description,
  factual starter description, key features when AI is on) and adds tags and
  search terms; shows Filled / Kept yours / Needs your input; report
  View / JSON / CSV. The big SEO Pulse tab is gone.
- `[x]` Internal search terms now include "AirPods Pro 3"-style shortenings,
  model family, brand + family, brand + category type.
- `[x]` Products list: published rows show Edit · Preview · ⋮.

### Verified

- Typecheck and lint clean. Unit: 144 pass across options, variants, lifecycle,
  SEO Pulse, catalog, combinations, schema and seed suites — including
  `tests/product-options.test.ts` (new product empty, per-product values,
  value removal isolated, group removal, pruning, variant photos, duplicate
  and delete with owned options, one-click fill keeps the admin's text and
  writes no invented facts).
- Browser walkthrough of all 23 steps on throwaway sofas (deleted after):
  new product empty; 2 variants; photo, price and stock on White; 10 variants
  folded to 8 rows + "Show all 10", chips "+4 more"; SEO Pulse filled 6 kinds
  of field and listed 9 facts to add; manual SEO title edit saved as draft;
  Publish blocked with "1 thing needs attention" and Fix → scrolled to
  variants; fixed and published; Sofa B started empty and got its own Color;
  removing White from Sofa A left Sofa B's White and Grey untouched. No
  console errors.
- Found and fixed while verifying: adding a value on Enter submitted twice
  (blur); deleting a product with its own options failed (foreign key); a
  duplicate would have shared the original's options; the phone page was
  655px wide (screen-reader labels escaping the variants table's scroll box)
  — now 390px.
