# Testing

## Approach

Unit and integration tests with Vitest, end-to-end flows with Playwright. Business logic lives in `lib/`, decoupled from routes and components specifically so it can be unit tested without an HTTP layer or a browser.

## What must have tests before a phase is marked done

- **Preorder capacity (`lib/preorder`).** Concurrent requests for the last remaining slot: exactly one succeeds, the rest fail cleanly with a message the shopper can act on. This is the single highest-value test in the codebase — it's the direct implementation of "no overselling / no over-preordering," and a regression here has an immediate financial consequence.
- **Idempotent order creation (`lib/orders`).** Two requests with the same idempotency key produce one order and one charge, not two.
- **Price integrity.** A price changed between add-to-cart and checkout is caught by the checkout transaction, not silently charged at the old or new price without the shopper seeing it.
- **Role enforcement (`lib/auth`).** A `customer` session cannot succeed at any product/variant/category/attribute mutation, by calling the `lib/` function directly, not only by hitting a route — since the invariant is stated as absolute in [SECURITY.md](SECURITY.md).
- **Order status transitions (`lib/orders`).** Only forward-or-terminal transitions are accepted; an out-of-order transition is rejected, not silently applied.
- **Review eligibility.** A user with no delivered `order_item` for a product cannot create a review for it, even with a crafted request.

## Integration tests

Run against a real Postgres instance (a disposable database per test run, migrated from the checked-in migrations — never the dev database). Cover the request flow described in [ARCHITECTURE.md](ARCHITECTURE.md): cart → checkout → payment confirmation → status progression, using the mock payment/shipping/notification providers.

## End-to-end tests (Playwright)

One happy-path spec per major flow, run against a seeded database:

- Browse → product detail → add preorder item to cart → checkout with deposit payment → see confirmation with delivery window.
- Admin: create a product with two attributes and four generated variant combinations, disable one, publish it, confirm it's visible and buyable on the storefront.
- Admin: advance an order through the full status pipeline, confirm the customer's tracking view updates to match.
- Admin: edit an existing product, reload, and confirm the change was read back from the server rather than left in the form; archive it behind a confirmation and restore it as a draft.
- Admin: place an order, then find the message it produced in the notification outbox, addressed to the email that placed it.
- Filter a category listing by price and by attribute value, confirm the count matches what is shown, and confirm a filtered URL can be opened directly.
- Type in the header search, pick a suggestion with the keyboard, and land on the product.
- A landed price is never added to: the cart figure carries through to checkout unchanged, and the order pages show the goods, freight and duty already inside it.
- Admin: only a super admin can change a site setting; staff see the values with disabled inputs, and both the page and the API refuse anyone else.
- Admin: walk a new product through all six wizard steps — including a real image upload and a real price — and confirm it is then visible on the storefront to a signed-out visitor.
- Axe-core runs at AA (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`) over the pages the spec names plus sign-in, tracking, an empty result and three admin screens, on mobile and desktop. Violations are reported with the rule and the offending element, because a bare count tells whoever reads the failure nothing.
- The scheduled sweep refuses every request without its shared secret — including one from a signed-in super admin — and delivers the outbox when given it.
- An account turns on two-factor authentication, signs out, and cannot get back in on the password alone; a wrong code is refused, a recovery code works once, and turning it off needs a current code.
- A delivered customer writes a review, staff approve it, and it appears on the product page for a signed-out visitor.

## What does not need a test

Pure presentation with no logic (a static layout component, a design-token value) is not unit tested. Visual correctness is checked by hand against [DESIGN_GUIDELINES.md](DESIGN_GUIDELINES.md) during phase verification, not asserted in code — a snapshot test of a design system this early would break on every legitimate visual iteration.

## Accessibility

Structural rules — one h1 per page, every control labelled, a visible focus ring — are asserted by hand in the flow specs. `e2e/accessibility.spec.ts` runs the real axe rule set on top of that, and it earns its place: the hand-written checks passed on eleven pages that axe failed on contrast. Colour is measured, not judged by eye.

## Verification gate per phase

Before a phase in [PROGRESS.md](PROGRESS.md) is marked complete: `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, then the dev server is actually run and the real workflow for that phase is exercised by hand, per CLAUDE.md §6. A phase is not "done" on green tests alone if its UI has not actually been looked at.

## Concurrency testing (Phase 6)

`tests/preorder-concurrency.test.ts` is the only suite that needs a real PostgreSQL server, started by `npm run db:server`. Everything else runs on in-process PGlite, which serves one connection and therefore cannot produce a race at all.

Two things this suite taught, both worth keeping in mind when writing others like it:

- **Warm the connection pool before racing.** Pools connect lazily, so without a warm-up the first transaction commits while the rest are still doing TCP setup. The suite then passes whether or not the code is correct.
- **Assert the shape of the failures, not just the count.** The database's own check constraint stops overselling even when the application-level lock is missing, so a test that only counts successful reservations passes either way. What the lock actually buys is that shoppers get a clean "that preorder is full" instead of a raw integrity error — so that is what the test asserts.

When the server is not running the suite skips, and a placeholder test records that it skipped. A race-condition test that silently does not run is worse than not having one.

## Concurrency testing, part two: the rate limiter

`tests/rate-limit-concurrency.test.ts` follows the same pattern for the same reason. PGlite cannot race, so the claim that two simultaneous attempts at the last slot in a window cannot both succeed is tested against the real server, with the connection pool warmed first. It was confirmed to fail when the single upsert is replaced by a read-then-write: 20 of 20 attempts allowed instead of 1.

## A failing setup reads as a skip

Vitest reports every test in a file as skipped when its `beforeAll` throws. `tests/seed.test.ts` applied only migration `0000` for a long time and nobody noticed, because the run said "8 skipped" rather than "6 failed". When a total moves and the passes did not, check what went from running to skipped.

## Verifying a test can fail

For any test guarding a rule with money behind it, break the rule deliberately once and confirm the test catches it. The no-overselling suite was confirmed this way: with `for update` removed it fails; with it restored it passes.
