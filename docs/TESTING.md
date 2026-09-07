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

## What does not need a test

Pure presentation with no logic (a static layout component, a design-token value) is not unit tested. Visual correctness is checked by hand against [DESIGN_GUIDELINES.md](DESIGN_GUIDELINES.md) during phase verification, not asserted in code — a snapshot test of a design system this early would break on every legitimate visual iteration.

## Verification gate per phase

Before a phase in [PROGRESS.md](PROGRESS.md) is marked complete: `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, then the dev server is actually run and the real workflow for that phase is exercised by hand, per CLAUDE.md §6. A phase is not "done" on green tests alone if its UI has not actually been looked at.
