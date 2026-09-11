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
- A shopper clicks a gallery thumbnail and the main image follows it; the main image opens a full-screen viewer that steps with the arrow keys and closes on escape; the page carries no sideways overflow at 360px.
- A listing with a warranty, certifications, box contents and category-defined specifications shows each of those sections, with one row per fact; a listing without them shows none of those headings at all.
- A variant on offer shows the sale price, the regular price it replaces, and the saving.
- Admin: saving one panel of the product editor leaves the others untouched — the property the whole split form depends on — and a SKU another product already carries is refused with the clash named.

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

## Testing a search you cannot eyeball

`tests/search.test.ts` seeds a product whose only connection to the search term
is a word in its description, or in one bullet point, or in a tag, or in its
category's name, or in an option value on a variant — one case per test, each
asserting the product comes back and an unrelated one does not. That shape
matters: a single test searching for a word that appears in three fields passes
even when two of the three are not searched at all.

Three of them exist because the behaviour is easy to lose in a rewrite:

- **"board" finds "Keyboard".** A stemmed prefix query cannot match inside a
  word, so the plain substring match on the title is what carries this. Someone
  tidying the query later will be tempted to drop it.
- **"blockquote" finds nothing** in a listing whose description contains
  `<p class='blockquote'>`. Markup is stripped before indexing, and a search
  that matches tag names is a search that ranks by how a description was
  written.
- **A draft is never returned** — the same public predicate as every other
  shopper query, asserted here rather than assumed.

`tests/recommendations.test.ts` does the same for each recommendation signal
separately, and asserts the fallback is *popular* rather than random by seeding
a catalogue where nothing scores at all.

`tests/homepage-hero.test.ts` covers the settings a shop's front page depends
on: that a corrupt row degrades to the defaults instead of throwing, that a
customer cannot write any of it, and that the call-to-action link refuses an
absolute URL — a text field that becomes an `href` is how an open redirect gets
built by accident.

`tests/homepage-showcase.test.ts` does the same for the row of four: the order
staff chose is kept, a duplicate is dropped rather than refused, the ceiling
holds, every change is audited with the row it replaced, and no customer can
write any of it.

`e2e/homepage-admin.spec.ts` is the one that stops the admin page being a fake
settings panel. It picks a product from the real control, saves, loads the
storefront with no session, asserts that product is in the row and that the row
is four cards, then puts it back. It takes the product from the control's own
options rather than naming one: this database accumulates products as the suite
runs, so a hard-coded title eventually falls off the end of the list, and what
is under test is that choosing *a* product works.

## Search and discovery

- `tests/search-engine.test.ts` — ranking tiers (exact name over accessory over
  mention; brand first; boost reorders only equals), codes (SKU with and
  without punctuation, variant SKU, barcode, model number), typo tolerance
  (prefix and stem need nothing; "samsng" → "Samsung"; a correction is never
  towards a draft's word; `spell=0` searches as typed), synonyms both ways and
  one way, hidden-from-search, and suggestions.
- `tests/search-index.test.ts` — changes the catalogue only through the
  application and then searches, so a trigger that stops firing fails: new
  product, rename, unpublish, archive, option added and disabled, option
  renamed, category renamed, specification answered/renamed/unsearchable/
  removed, and a capacity change that must *not* reindex. A queued row left
  behind (trigger disabled to simulate a failed rebuild) is retried by the
  sweep.
- `tests/discovery.test.ts` — RAM offered over laptops and never over shoes,
  one colour filter across variation and specification, facet counts against
  other filters, unknown URL keys dropped, per-variant price ranges, sale
  filter and discount sort, sort options offered only with data behind them.
- `tests/search-analytics.test.ts` — the three-visitor threshold, no
  email/phone searches stored, daily-rotating visitor hash, report is staff
  only, pruning, and history per account removed on anonymisation.
- `e2e/search.spec.ts` — header box keyboard and Escape behaviour, recent
  searches, results page state in the URL, correction notice, empty page with
  related searches, chips, `noindex`, axe with filters on, staff hiding a
  product and adding a synonym, and the phone full-screen search.

One PGlite trap found writing these: `updateProduct` derives a new slug
through the base connection while its transaction is open. On a real server
that is another pooled connection; on single-connection PGlite it waits for
itself forever. The tests pass an explicit slug when renaming.

A second test in that file asserts the hero image is bare — no link, no button,
no heading, and no text at all inside the region. That is a rule the owner
stated, and it is the kind of thing that creeps back one helpful caption at a
time.

## Account features

`tests/account.test.ts` (PGlite) covers the wishlist and save-for-later
ownership rules, live pricing of saved items, the copy-on-write address rule
against a real placed order, newsletter idempotency, and recently-viewed cookie
parsing. The browser flows were driven by hand against the dev server; no e2e
spec was added for them yet.

## Added this session

- `tests/customer-spend.test.ts` — spend is zero with no orders, counts paid
  statuses only, accumulates, never crosses customers; permission gate.
- `tests/homepage-campaigns.test.ts` — five slots, legacy conversion, only
  live slides reach the storefront, image/slide rules, destination
  validation, `homepage.manage` gate.
- `tests/authorize.test.ts` — the role/permission table.
- `tests/seo-pulse.test.ts` (33) — keyword normalisation and deduplication,
  slugs, text limits, both scores, the rules generator (no invented
  misspellings, photographs flagged for review), AI-output validation
  (missing fields rejected, foreign image ids dropped, unsafe HTML stripped),
  panel status; against PGlite: versioned runs, reuse of unchanged research,
  request-key idempotency, one run at a time, external provider failure,
  external data stored with its source, AI failure falling back to rules, site
  search as first-party research, permissions per role, apply filling empty
  fields, refusing silent overwrites (text, lists, alt text), slug conflicts,
  synonyms never edited, and JSON/CSV export contents. External providers are
  replaced with test doubles through `setSeoDataProviderForTesting` /
  `setIntelligenceProviderForTesting`.
- `e2e/homepage-admin.spec.ts` rewritten for campaigns; `filters.spec.ts`
  updated for instant filters (reads `[data-result-count]`).
- The e2e suite can run beside a running dev server only against the production
  build (Next 16 refuses a second `next dev` in one folder): `next build`, then
  `PORT=3100 E2E_PRODUCTION=1
  E2E_BASE_URL=http://localhost:3100 npx playwright test …`.
