# Production Readiness Ledger

The working record of the programme that takes Manifest from its audited state
([INITIAL_TECHNICAL_AUDIT.md](INITIAL_TECHNICAL_AUDIT.md)) to production. Each
item carries its status, where it lives, how it was verified, and what was
measured. This file is the source of truth for "is it done"; `PROGRESS.md`
keeps the older feature history.

Status vocabulary: `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `COMPLETE`
(implemented, tests written) · `VERIFIED` (tests pass and the behaviour was
exercised against a real database or browser).

Branch: `production-readiness`, cut from `main` at `6b22ba9`.

---

## Phase 0 — Baseline (2026-09-15, commit `6b22ba9`)

Taken during the initial audit on the same commit, with no code changed since.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS — 56 files, 883 passed, 2 skipped, 100.7 s |
| `npm run build` | PASS — 2 min 46 s |
| Production E2E (both projects) | FAIL — 446: 385 passed, 55 failed, 6 skipped, 14.4 min |
| Concurrency: single variant, 20 racers for 1 slot | PASS (`tests/preorder-concurrency.test.ts`) |
| Concurrency: 40 two-line carts, opposite order | FAIL — 27 of 40 `deadlock detected` (audit probe) |
| Concurrency: 10 same-key submissions | FAIL — 1 order, 9 raw unique violations → HTTP 500 |

Audit findings confirmed still present in code at this commit: all of them
(the code had not changed since the audit).

Documentation vs code discrepancies found:

- `SECURITY.md` describes password reset, webhook signature verification and
  image re-encoding; none existed. (Webhook signatures now exist — Phase 3.)
- `ARCHITECTURE.md` describes revalidated category/product pages; all are
  `force-dynamic`.
- `DATABASE.md` opens with three roles; there are eight.
- Media docs name Cloudflare R2; the implementation is Vercel Blob.

TODO/FIXME markers in application code: none.

---

## Phase 1 — Measurement and regression harness

| # | Item | Status | Files | Verification |
| --- | --- | --- | --- | --- |
| 1.1 | Scale data generator, refuses non-scratch databases | VERIFIED | `db/seed-scale.ts`, `db/scratch-guard.ts`, `tests/scratch-guard.test.ts` | Guard: 10 unit tests (names, remote hosts, production env, malformed URLs). Generator run against `manifest_scale`: 5,000 products, 18,731 variants, 20,001 users, 100,000 orders, 200,203 lines, 59,651 reviews, 301 MB in 1 min 34 s. Refuses a database holding orders it did not generate. |
| 1.2 | Checkout concurrency regression tests | VERIFIED | `tests/checkout-concurrency.test.ts`, `tests/helpers/real-database.ts` | Scenarios A (same-order two-line), B (opposite order ×5 rounds), C (30 shoppers / 5 slots), D (10 same-key), E (confirmation replay), F (cancellation release vs checkouts), H (three-line permutations ×5). G (expiry vs checkout) lands with Phase 6. B and H use a test-only trigger that slows each variant update by 15 ms, which makes the lock interleaving certain instead of timing-dependent. |
| 1.3 | Benchmark / load harness | COMPLETE | `scripts/perf/bench.ts` (`npm run perf:bench`), `scripts/perf/http-load.mjs` (`npm run perf:http`) | p50/p95/p99, statements per path, requests/s, error rate, peak DB connections (pg_stat_activity), HTML raw/gzip, first-load JS gzip. First full runs recorded with Phase 8. |

**Reproduction before the fix** (commit `6b22ba9` code, new tests):

| Scenario | Result |
| --- | --- |
| B — 200 opposite-order checkouts | FAIL — 104 × `40P01 deadlock detected` |
| D — 10 simultaneous same-key submissions | FAIL — 9 × `23505 orders_idempotency_key_unique` |
| H — 180 three-line permutation checkouts | FAIL — 23 × `40P01` |
| A, C, E, F | PASS |

## Phase 2 — Checkout correctness

| # | Item | Status | Files | Verification |
| --- | --- | --- | --- | --- |
| 2.1 | Deterministic variant locking | VERIFIED | `lib/preorder/capacity.ts` (`reserveCapacityForLines`), `lib/orders/place.ts`, `lib/orders/transitions.ts` | One `select … where id in (…) order by id for update` locks every cart variant; all lines checked before any write; duplicate lines summed. Cancellation and refund release in variant-id order; `advanceOrder` locks the order row. Scenario B: 200/200 checked out, 0 deadlocks. H: 0 deadlocks, exactly 12 orders per round. |
| 2.2 | Idempotency race resolves to the existing order | VERIFIED | `lib/orders/place.ts` | `pg_advisory_xact_lock(hashtextextended(key))` as the transaction's first statement, then re-check inside the lock; unique-violation fallback returns the existing order. Scenario D: 10/10 fulfilled, one order id, one order row, one payment row. |
| 2.3 | Bounded retry for deadlock / serialization failure | VERIFIED | `lib/db-errors.ts` (`withTransientRetry`) | 3 attempts, jittered backoff, only `40P01`/`40001`; whole transaction retried, provider call happens after commit so no side effect repeats. Unit tests: retries then succeeds, gives up at limit, never retries a check violation. |
| 2.4 | Typed error contract | VERIFIED | `lib/errors.ts`, `lib/api-error.ts`, `tests/error-contract.test.ts` | Known SQLSTATEs map to 503 + `Retry-After` (deadlock/serialization), 409 (unique/foreign key/check), 400 (invalid text); driver text never returned. `TransientConflictError` when retries run out. 12 tests. |

## Phase 3 — Payment state and security

| # | Item | Status | Files | Verification |
| --- | --- | --- | --- | --- |
| 3.1 | Payment state persisted; mock provider stateless | VERIFIED | `lib/providers/payment/mock.ts` | References derived from the idempotency key; a declined attempt is marked in the reference. A provider instance that never saw the payment created confirms it (restart / other instance test). |
| 3.2 | Payment row written in the order transaction | VERIFIED | `lib/orders/place.ts` | `payments` row inserted `initiated` with the order; provider called after commit and its reference written back; a throwing provider marks the row `failed` and the order stands until its hold expires. `PlacedOrder.paymentStatus` reports it. |
| 3.3 | `/api/checkout/confirm` guarded | VERIFIED | `app/api/checkout/confirm/route.ts` | 404 whenever `NODE_ENV=production`; otherwise only with the mock provider. Test stubs production and asserts 404. |
| 3.4 | Signed, idempotent provider webhooks | VERIFIED | `app/api/webhooks/payments/[provider]/route.ts`, `lib/payments/webhooks.ts`, `lib/orders/confirm.ts` (`recordCapturedPayment`), `lib/payments/reconcile.ts`, `db/schema/payment-events.ts`, `tests/payment-webhooks.test.ts` | HMAC-SHA256 over `timestamp.body`, 5-minute window, 64 KB cap, unconfigured secret refuses everything. Event recorded under unique (provider, event_id), claimed by guarded update, processed through one locked, amount-checked path. Tests: valid capture, duplicate (no second history row), forged signature (nothing stored), stale timestamp, wrong provider (404), amount mismatch (not confirmed; redelivery retries, attempts 2), failure event, payment after cancellation (recorded, order not reinstated, refund note), stuck `processing` event released by reconciliation. Scenario E: 10 concurrent confirmations → one history row. |

Migration: `0023_payment_events.sql`.

## Phase 4 — E2E recovery and environment

| # | Item | Status | Files | Verification |
| --- | --- | --- | --- | --- |
| 4.1 | E2E failures classified and repaired | VERIFIED | see classification below | All 55 classified and repaired at the correct layer (2 real defects fixed in the application). Full production E2E after Phase 10: **440 passed, 0 failed, 6 skipped** (4.1 min; baseline 385/55/6 in 14.4 min). |
| 4.2 | Loading-skeleton ARIA violation | COMPLETE | `app/admin/products/loading.tsx`, `app/admin/products/[productId]/loading.tsx` | `aria-label` on a role-less `div` is prohibited; the container keeps `aria-busy` and announces loading through a visually hidden `role="status"` message. Axe no longer reports it; the same spec then surfaced a title race (E, below). |
| 4.3 | Node 22 pinned; Vitest warnings and noise | IN PROGRESS | `.nvmrc`, `vitest.config.mts` | `.nvmrc` = 22 matches `engines`. Config now ESM with native `resolve.tsconfigPaths`; `vite-tsconfig-paths` removed. Real-Postgres suites run as a separate, sequential project after the unit group — running them beside each other exhausted the server's 100 connections and timed out a teardown. Local machine still runs Node 24.20.0 (no version manager installed); CI will run 22. |

### E2E failure classification (baseline run, 55 failures)

Classes: A real application defect · B stale test · C stale selector ·
D layout/expectation mismatch · E test infrastructure/timing · F unknown.

| Spec (tests × viewports) | Symptom | Cause | Class | Fixed in |
| --- | --- | --- | --- | --- |
| shipping (5×2), cancellation-requests (4×2), landed-price (3×2), notifications placing (1×2), cron (1×2), reviews (1×2) — 30 | `waitForResponse` on `POST /api/cart` times out after 180 s | The seeded candy box has options (D-043). Pressing Add with none chosen correctly opens the chooser and sends nothing; the old helper never chose. Not an application bug: the passing checkout spec already chose an option. | B | Shared `e2e/helpers/cart.ts` `addToCart` |
| same checkout specs, second pass — 16 | `getByLabel('Email')` resolves to 2 elements | The header sign-in dialog (D-050) is always in the document and has its own Email field. | C | `fillGuestCheckout` scoped to `main`; reviews spec scoped likewise |
| analytics (5×2) — 10 | "Revenue", "Funnel", "Not measured yet", "Last 7 days", "Preorder commitment" not found; "Orders placed" matches 2 | Page redesigned for phones (`86e376f`). Behaviour intact: money behind `finance.view`, funnel still names what is not recorded, utilisation still reported. | D (C for the duplicate) | Spec rewritten against the page's real sections |
| landed-price settings (1×2) | Staff cannot see Settings heading | Since D-034 `staff_admin` has no `settings.manage`; the test predates the role split. | B | Asserts refusal (`/admin?denied=1`) and API 403 |
| notifications outbox notice (1×2) | Notice text not found | Notice moved into the "Customer messages" tab. | D | Spec opens `?tab=messages` |
| security sign-out (1×2) | Heading "Today" not found | Dashboard heading is now a greeting. | D | Asserts the level-1 heading |
| preorder-windows capacity (1×2) | Product link resolves to 2 | Row gained a "Preview …" storefront link. | C | Exact link name |
| accessibility preorder windows (1×2) | axe `aria-prohibited-attr` on skeleton; then `document-title` | First: real ARIA misuse. Second: the spec audited immediately after a client-side navigation, before the title updated (verified: the page's HTML carries the title). | A, then E | Skeleton fixed; spec waits for URL and title |
| admin-variants (1, mobile at baseline, both in rerun) | Second group created 2 variants, not 4 | **Real defect.** The variant screen sends the groups it last rendered; a second group added before the refresh landed was sent alone, and the server replaced the product's groups with it — pruning every variant of the first group. Two staff editing one product would lose data the same way. | A | `setProductAttributes` never drops a product-owned, still-linked group by omission; explicit removal unchanged. Regression tests in `tests/product-options.test.ts`. |
| seo layout shift (1×2) | 1 unsized image | Gallery's main SVG fills a lightbox `<button>` that fills the sized frame; the test only looked at the direct parent. | D | Test walks up through filling wrappers |
| filters autosuggest (1 desktop at baseline, the keyboard variant in rerun) | Suggestions listbox never appears | Production mode enables the in-memory suggest throttle (40 per 10 s per visitor); every browser in the suite is one visitor. | E | Ceilings now `SEARCH_SUGGEST_LIMIT` / `SEARCH_CLICK_LIMIT` (defaults unchanged); production E2E raises them as it does the login ceilings |
| search hide-from-search (1 desktop) | Editor section button not found in time | Passed in the rerun with no change; timing under the full parallel run. | E | — |

## Phase 5 — Migration safety

| # | Item | Status | Files | Verification |
| --- | --- | --- | --- | --- |
| 5.1 | Migration ledger | VERIFIED | `db/migrator.ts`, `db/migrate.ts`, `db/setup.ts`, `e2e/prepare-db.ts`, test helpers, `tests/migrations.test.ts` | `schema_migrations` (name, checksum, mode, duration). Each pending file in one transaction with its ledger row; failure rolls back and names the file; edited applied file refused; advisory lock against concurrent deploys. A pre-ledger database replays 0000–0022 the old way once and records them `baselined`. Tests: fresh apply; second run no-op; previous-release database with data → baselined + new files applied strictly, data kept; failing migration rolled back, invisible in ledger, applies once fixed; checksum drift refused. Real server: development database `preorder` upgraded — 23 baselined, 35 products / 7 orders / 5 users intact, second run 0 applied. `npm run db:migrate` now uses this runner (drizzle-kit's journal was 20 migrations stale). |

---

## Remaining ledger

| # | Item | Status |
| --- | --- | --- |
| 6.1 | Unpaid-order expiry (30 min default, D-052) — VERIFIED: `lib/orders/expiry.ts`, setting `orders.unpaid_hold_minutes`; `tests/order-expiry.test.ts` 8/8 (expiry, stock return, repeat sweep, inside window, paid, COD, moved-on, setting); real Postgres G1 (5 concurrent sweepers × 20 orders → each once), G2 (expiry vs capture → confirmed or cancelled-with-refund-note, reserved matches), G3 (released places vs 30 checkouts → no oversell). Runs from the maintenance sweep until the job runner lands. | VERIFIED |
| 7.1 | Durable job runner (D-053) — VERIFIED: `lib/jobs/runner.ts`, `lib/jobs/registry.ts`, `/api/cron/jobs`, `/api/admin/jobs`, migration 0024. `tests/jobs.test.ts` (dedupe, per-slot scheduling, run once, not-yet-due, backoff then dead-letter, unknown kind, stale-worker recovery, owner-only retry, delivery claims); real Postgres: 6 workers × 60 jobs → each once, 5 drains × 30 messages → each sent once. **Frequent trigger BLOCKED on hosting plan** (Vercel Hobby cron is daily). | VERIFIED |
| 8.1 | Justified indexes — VERIFIED with `EXPLAIN ANALYZE` on `manifest_scale` (migration 0025): `orders (placed_at DESC, id DESC)` and `orders (status, placed_at DESC, id DESC)` added, `orders_status_idx` dropped as redundant. Measured and **not** added: trigram indexes for order search (planner did not use them for the seven-column `OR`); `sessions (expires_at)` and `cart_items (variant_id)` (no evidence at current volumes). | VERIFIED |
| 8.2 | Server-side / keyset pagination in admin — VERIFIED: orders by keyset cursor for newest/oldest (offset kept for total sorts), customers page-first with per-row totals, products filtered/sorted/counted/paged in SQL. Tests: `tests/admin-order-list.test.ts` (every order once through ties, back-paging, filters/search, total sorts, cursor validation), `tests/admin-product-list.test.ts` (counts, status/inventory/category/search filters, sorts, paging clamp, thumbnails, access); customer-spend and admin-ops suites unchanged and passing; products page checked in a browser. | VERIFIED |
| 8.3 | Streamed CSV export — VERIFIED: keyset batches of 5,000 streamed to the response; string wrapper kept for callers and tests. Background export job not built: 100,000 orders stream in 1.9 s, inside a request budget. | VERIFIED |

### Phase 8 measurements (`manifest_scale`: 5,000 products, 18,731 variants, 20,001 users, 100,000 orders; median of 7 warm runs, one machine, database on the same host)

| Path | Audit baseline | After |
| --- | ---: | ---: |
| Admin orders page 1 | 278 ms | 17 ms |
| Admin orders 1,000 pages deep | 369 ms (offset) | 10 ms (keyset) |
| Admin orders by total, deep page | — | 124 ms (offset, rarely used) |
| Admin orders search | 193 ms | 50 ms |
| Admin customers page 1 | 49 ms | 7 ms |
| Admin products list | 195–220 ms, all 5,000 rows to the browser | 33 ms, 50 rows |
| Orders CSV export (100k) | 960 ms, 8 MB string in memory | 1.9 s streamed, 41 batches, bounded memory |
| Query plan: orders page 1 | 202 ms (hash aggregate over 200k lines) | 0.44 ms |
| Query plan: 1,000 pages deep | 42 ms, sort to disk | 0.02 ms |
| 9.1 | Listing read model — VERIFIED: `product_listing_stats` (migration 0026) holds units sold, approved review count and rating average, recomputed exactly (never incremented) by statement-level triggers on order status changes, order-line inserts/deletes and review inserts/updates/deletes; backfilled on migration (52 s for 5,000 products / 100,000 orders). `salesUnitsSql`, `ratingAverageSql`, `reviewCountSql` read it. Price, discount and buyable-now stay read-time (clock-dependent). `tests/listing-stats.test.ts`: consistency with a fresh aggregate through placed→paid→refunded, line add/remove, bulk status change, review approve/reject/delete, backfill; best-selling and rating sort order identical to sorting from source rows. Measured: whole catalogue best-selling 532 → 25 ms; shelf best-selling 153 → 77 ms; search 82 → 46 ms. Not improved: filtered shelf 267 ms — its cost is attribute/spec matching in facets, not history aggregation; left for a later measured pass. | VERIFIED |
| 10.1 | Cache Components — IN PROGRESS. Done and verified: `cacheComponents` on; all `force-dynamic` removed; every route `instant = false`; handlers that would freeze at build fixed (Google sign-in → `connection()`, popular searches and sitemap → cached helpers); shared storefront data cached (`lib/catalog/cached.ts`: menu, homepage rows, category/search listings, product content/reviews/recommendations); live buy-box variants, sessions, carts, previews and homepage campaigns per request; invalidation from the audit log after commit (`runAfterCommit`, `tests/after-commit.test.ts`). Defect found and fixed: simultaneous homepage slide edits erased each other (`tests/homepage-concurrency.test.ts`). Accepted, documented race: an entry computing from pre-commit rows can stay about a minute behind (D-054). Measured on `manifest_scale`, one process, 20 concurrent clients: `/` 39.5 → 57.5 req/s; root category 18.8 → 106; leaf category 36.6 → 44; search 32.1 → 45.4 and 21.6 → 47.3; product 30.9 → 51.8; 250-variant product 11.5 → 14.2; sitemap 59 → 1,254. Remaining: routes still render per request (`instant = false`); static shells with streamed per-user parts not yet converted. | IN PROGRESS |
| 11.1 | Image derivative pipeline + orphan cleanup | NOT STARTED |
| 12.1 | Client payload ≤170 KB gzip; compact variant payload | NOT STARTED |
| 13.1 | Mobile Core Web Vitals | NOT STARTED |
| 14.1 | Admin scalability | NOT STARTED |
| 15.1 | Product page / publish-readiness correctness | NOT STARTED |
| 16.1 | Storefront UX completion | NOT STARTED |
| 17.1 | Mobile / tablet UX pass | NOT STARTED |
| 18.1 | Auth / account regression | NOT STARTED |
| 19.1 | SEO + SearchPulse review workflow | NOT STARTED |
| 20.1 | Security hardening (Origin, nonce CSP, docs accuracy) | NOT STARTED |
| 21.1 | Pooled database, maintenance | NOT STARTED |
| 22.1 | Observability | NOT STARTED |
| 23.1 | CI/CD | NOT STARTED |
| 24.1 | Real payment providers | BLOCKED — needs provider credentials |
| 25.1 | Courier integrations | BLOCKED — needs courier credentials |
| 26.1 | Final load test in production topology | NOT STARTED |
