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
| 4.1 | E2E failures classified and repaired | NOT STARTED | | |
| 4.2 | Loading-skeleton ARIA violation | NOT STARTED | | |
| 4.3 | Node 22 pinned; Vitest warnings and noise | IN PROGRESS | `.nvmrc`, `vitest.config.mts` | `.nvmrc` = 22 matches `engines`. Config now ESM with native `resolve.tsconfigPaths`; `vite-tsconfig-paths` removed. Real-Postgres suites run as a separate, sequential project after the unit group — running them beside each other exhausted the server's 100 connections and timed out a teardown. Local machine still runs Node 24.20.0 (no version manager installed); CI will run 22. |

## Phase 5 — Migration safety

| # | Item | Status | Files | Verification |
| --- | --- | --- | --- | --- |
| 5.1 | Migration ledger | VERIFIED | `db/migrator.ts`, `db/migrate.ts`, `db/setup.ts`, `e2e/prepare-db.ts`, test helpers, `tests/migrations.test.ts` | `schema_migrations` (name, checksum, mode, duration). Each pending file in one transaction with its ledger row; failure rolls back and names the file; edited applied file refused; advisory lock against concurrent deploys. A pre-ledger database replays 0000–0022 the old way once and records them `baselined`. Tests: fresh apply; second run no-op; previous-release database with data → baselined + new files applied strictly, data kept; failing migration rolled back, invisible in ledger, applies once fixed; checksum drift refused. Real server: development database `preorder` upgraded — 23 baselined, 35 products / 7 orders / 5 users intact, second run 0 applied. `npm run db:migrate` now uses this runner (drizzle-kit's journal was 20 migrations stale). |

---

## Remaining ledger

| # | Item | Status |
| --- | --- | --- |
| 6.1 | Unpaid-order expiry (30 min default, D-052) | NOT STARTED |
| 7.1 | Durable job runner | NOT STARTED |
| 8.1 | Justified indexes (EXPLAIN verified) | NOT STARTED |
| 8.2 | Server-side / keyset pagination in admin | NOT STARTED |
| 8.3 | Streamed / background CSV export | NOT STARTED |
| 9.1 | Listing read model | NOT STARTED |
| 10.1 | Cache Components, tag invalidation in `lib/` | NOT STARTED |
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
