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
- `[ ]` **Phase 10 — Shipping.** Tracking abstraction (mock), manual tracking updates from admin.
- `[ ]` **Phase 11 — Admin ops.** Dashboard metrics, staff/role management, CSV export, audit log viewer.
- `[ ]` **Phase 12 — Analytics.** Funnel and revenue reporting from real data.
- `[ ]` **Phase 13 — SEO/performance.** Metadata, structured data, sitemap, performance budget pass.
- `[ ]` **Phase 14 — Security hardening.** Full pass against `SECURITY.md`.
- `[ ]` **Phase 15 — Full QA.** End-to-end regression across every flow in `MASTER_PRODUCT_SPEC.md`.

Each phase stops for explicit go-ahead before the next begins, per CLAUDE.md §6.

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

## Open items carried from other docs

- `MASTER_PRODUCT_SPEC.md` open questions: minimum batch/order economics, exact refund policy detail, exact deposit/balance trigger.
- `SECURITY.md` open questions: 2FA for admin roles, data-retention period under Bangladeshi law.
- `DATABASE.md` open questions: whether balance payment is auto-triggered or staff-triggered; automatic waitlist re-offer vs manual.

These don't block Phase 1 (scaffold has no dependency on their answers) but should be resolved before Phase 6 (preorder engine) and Phase 8 (checkout) reach them.
