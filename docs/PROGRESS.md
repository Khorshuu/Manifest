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
- `[ ]` **Phase 6 — Inventory & preorder engine.** Capacity/reserved tracking, the locked-transaction capacity check, waitlist.
- `[ ]` **Phase 7 — Storefront.** Home, category/PLP, PDP, search, related products.
- `[ ]` **Phase 8 — Cart & checkout.** Cart persistence, address, payment method selection (mock provider), idempotent order placement.
- `[ ]` **Phase 9 — Orders.** Customer order history/tracking, admin order pipeline, status transitions, refunds.
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

## Open items carried from other docs

- `MASTER_PRODUCT_SPEC.md` open questions: minimum batch/order economics, exact refund policy detail, exact deposit/balance trigger.
- `SECURITY.md` open questions: 2FA for admin roles, data-retention period under Bangladeshi law.
- `DATABASE.md` open questions: whether balance payment is auto-triggered or staff-triggered; automatic waitlist re-offer vs manual.

These don't block Phase 1 (scaffold has no dependency on their answers) but should be resolved before Phase 6 (preorder engine) and Phase 8 (checkout) reach them.
