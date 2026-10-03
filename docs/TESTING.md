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
- `tests/search-knowledge.test.ts` — Stage 5, the knowledge-backed search. The
  cases worth knowing about:
  - **Normalization parity is asserted, not assumed.** `search_term_key` in SQL
    and `termKey` in TypeScript are run over the same nine inputs — accents,
    punctuation, `&`, padding, an empty string — and compared one to one. If
    either is ever changed alone, this fails. A quantity typed three ways
    ("256gb", "256 GB", "256 gigabytes") must produce the identical canonical
    term, because that is the whole claim of D-089.
  - **A negative case guards the normalization**: "2 in 1 case" must *not* be
    read as a 50.8 mm length. Aggressive normalization does not fail loudly, it
    quietly widens a search to unrelated products, so the rule that stops it has
    a test of its own.
  - **Ranking regressions** are the point of four cases: an exact product above
    one that merely shares its colour, an exact model above five broad attribute
    matches, the staff boost still unable to lift a weaker match, and a typed
    quantity not flattening the ranking of everything else.
  - **Aliases** are tested through their whole life: suggested (finds nothing),
    approved (finds it), inside a longer search (does not name that product),
    rejected (stops finding it). And that `zeroResultIntelligence` proposes one
    without recording it.
  - **Facets** — one filter from two spellings of one attribute, a value
    filtered however the link spells it, a brand spelled twice counted once,
    meaningless attributes not offered, the brand never offered twice, and 60
    variants counted once.
  - **Analytics** — a filter event keeps the keys and not the values, a
    refinement points at the search it replaced, a personal-looking search is
    recorded nowhere, and a conversion is counted once and erased (running it
    twice, as a replayed webhook would, counts nothing the second time).
- `e2e/search.spec.ts` — header box keyboard and Escape behaviour, recent
  searches, results page state in the URL, correction notice, empty page with
  related searches, chips, `noindex`, axe with filters on, staff hiding a
  product and adding a synonym, and the phone full-screen search. Also: typing
  asks for suggestions fewer times than keystrokes, and Enter or the Search
  button navigates without a suggestion request for the submitted query.
- `tests/search-autocomplete.test.ts` — the header box's request control with
  fake timers: 250 ms debounce reset per keystroke, the two-character floor
  and whitespace, one request for fast typing or a paste, abort of superseded
  requests, AbortError never a failure, a late older answer never shown or
  cached, clear and cancel immediate, delayed loading mark, bounded cache.

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

## Product Knowledge Base (Stage 2)

- `tests/pkb-normalization.test.ts` — exact decimal conversion; storage, mass,
  length, temperature and ranges read however written; refusals instead of
  guesses (decimal commas, missing or wrong units); unknown vs false vs zero;
  ISO dates at written precision; enum matching by key, label and alias; GTIN
  check digits, UPC/EAN/GTIN-14 equivalence, ISBN-10/13, model-number folding.
- `tests/pkb-backfill.test.ts` (PGlite) — every listing and offer imported;
  only LEGACY of unknown origin; normalized values with raw text kept;
  unreadable values kept raw; unplaceable values parked with reasons; one GTIN
  per product; similar brands reported, never merged; category specifications
  mirrored as versioned families, products never forced into one;
  completeness; a second run writes nothing; reconciliation report clean.
- `tests/pkb-sync.test.ts` (PGlite) — staff saves are MANUAL and credited only
  with what changed; clearing keeps history; a locked value refuses the save
  and nothing is written; waiting unattributed changes settled first;
  unattributed changes accepted over LEGACY and reverted over decided values;
  every staff write path (options, variants, duplicate, delete, category
  specifications) leaves nothing queued; provenance survives a definition
  remap; knowledge-native values written back or detached; not-applicable.
- `tests/pkb-model.test.ts` (PGlite) — the database's own refusals (VERIFIED
  rules, value shape, cardinality, append-only history, AI source types, GTIN
  uniqueness, cross-product variants, permanent keys, active schema immutability,
  family cycles); family suggestion, approval by `knowledge.manage` only,
  rejection, versioning without touching values; sources recorded once;
  claims SUGGESTED or CONFLICT without touching a locked value; relationships
  both ways; alias approval rights and uniqueness; export eligibility.
- `tests/pkb-sync-concurrency.test.ts` (real PostgreSQL) — staff saves, writes
  behind `lib/`, and four queue workers on the same eight listings for four
  rounds: no failure, no duplicate slot, queue drains, reconciliation clean.

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
  `E2E_PRODUCTION=1 E2E_BASE_URL=http://localhost:3200 npx playwright test …`.
  The configuration passes the URL's port to the server it starts, so `PORT`
  no longer has to be set by hand.
- Mobile lab vitals: `npm run perf:vitals -- --base http://localhost:3100
  --paths "/,/cart" [--variant <uuid>] [--tap <selector>] [--warm]`
  (`scripts/perf/vitals.mjs`): a Pixel-class phone, CPU slowed 4×, slow 4G;
  LCP (read before scrolling), CLS across a scroll to the bottom, TBT, a tap's
  event duration, and bytes by type with the largest images. Lab figures, for
  before/after comparison on one machine.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request, in two jobs:

1. **checks** — `npm ci`, `npm run typecheck`, `npm run lint`, `npx vitest run`.
   A PostgreSQL 17 service container is available, so the real-PostgreSQL
   concurrency suites run instead of skipping (`CONCURRENCY_TEST_ADMIN_URL`).
2. **build-and-e2e** (after checks pass) — creates `preorder_e2e`, builds for
   production, runs the targeted end-to-end specs on the desktop profile, then
   starts the build and runs the performance budgets.

`.github/workflows/nightly.yml` (daily, and by hand from the Actions tab) runs
the full end-to-end suite on both profiles, the budgets, and
`npm audit --omit=dev --audit-level=high`.

Every database address in CI is the service container and every secret is a
test value; the workflows cannot reach production data.

### Protecting `main`

Once both CI jobs have passed on GitHub at least once (GitHub only offers a
check as required after it has run), require them before merging to `main`:
Settings → Branches → add a rule (or ruleset) for `main` with "Require a pull
request before merging", "Require status checks to pass" with
**Typecheck, lint, unit and integration tests** and
**Production build, targeted end-to-end tests, budgets**, "Require branches to
be up to date", and "Do not allow bypassing". With the GitHub CLI, as a
repository administrator:

```sh
gh api -X PUT repos/Khorshuu/Manifest/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Typecheck, lint, unit and integration tests",
      "Production build, targeted end-to-end tests, budgets"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null
}
JSON
```

The nightly and scheduler workflows are not required checks: they do not run
on pull requests.

### Performance budgets

`npm run perf:budget -- --base http://localhost:3000 [--paths "/,/cart"] [--js 170] [--html 60]`
fetches each page, adds up the gzipped size of every script it loads (legacy
`nomodule` polyfills excluded) and of the HTML, and exits 1 if any page is over
budget or answers with an error. Run it against a production build
(`next build && next start`); the development server's bundles are far larger.
When a change legitimately needs more JavaScript, raise the default in
`scripts/perf/budget.mjs` in the same pull request so the increase is reviewed.

### Product knowledge and intelligence

| Suite | Covers |
| --- | --- |
| `tests/pkb-normalization.test.ts` | Exact decimal arithmetic, the unit registry, identifier normalization and check digits |
| `tests/pkb-model.test.ts` | The database's own rules: value shapes, verification states, append-only history, GTIN uniqueness, immutable active family versions |
| `tests/pkb-sync.test.ts` | The legacy mirror under real catalogue writes: attribution, locks, unattributed changes, nothing left queued |
| `tests/pkb-sync-concurrency.test.ts` | Two concurrent saves of one listing, against real PostgreSQL |
| `tests/pkb-backfill.test.ts` | Importing existing listings as LEGACY, and the reconciliation report |
| `tests/pkb-net.test.ts` | Address policy, pinned DNS, redirects into private ranges, timeouts, size limits, content types, robots.txt |
| `tests/pkb-intelligence.test.ts` | Resolution states and the enrichment gate, the reviewed label-mapping workflow and its reuse, registry trust and verification policies, conflicts, all-or-nothing approval, attribute discovery, identifier history, provided documents, identity gating |
| `tests/pkb-write-paths.test.ts` | Risk R-5: a source check that fails when a new `lib/catalog` write path writes a mirrored table without locking or syncing it |

`tests/pkb-intelligence.test.ts` runs on PGlite like the rest of the unit
suites; nothing in it reaches the network, because retrieval is exercised
through `safeFetch`'s test seams in `tests/pkb-net.test.ts` and through
`provideDocument`, which takes the text a person supplies.

### The SEO engine

`tests/seo-engine.test.ts` (14 tests) covers Stage 4: a published listing keeps
its address when renamed while a draft's follows the title, an address a listing
leaves redirects and never shadows a live one, a canonical is refused unless it
stays on this site, a staff save records who decided each field with its before
and after, a locked field refuses an automatic change but not a person's,
structured data is a Product or a ProductGroup with one offer per variant and
availability from the same rule the buy box uses, an identifier is published
only once it is verified or staff-entered, internal links come only from
accepted relationships pointing at public listings, and the health screen counts
real failures with examples.

`tests/seo-audit.test.ts` (11 tests) covers the auditing half of Stage 4: the
image findings (a filename for alt text, two photographs described identically,
a file too small, a file too heavy, a file with no recorded size) and that
auditing changes no alt text; the catalogue image counts ignoring drafts; an alt
suggestion built only from established values, with nothing invented about the
picture; duplicate groups and a shared opening told apart from an exact copy;
thin pages and shelves still relying on the generated sentence; why a page is
not indexed and where its canonical points; an old address taken over by a live
listing; empty and hidden shelves; how many listings nothing links to, before
and after a relationship exists; a relationship that leads nowhere; and a shelf's
SEO fields surviving a rename with their HTML reduced to the allow-list.

`e2e/seo.spec.ts` checks the rendered page: the JSON-LD on a real product, that
its price matches the price on the page, the breadcrumb trail, the sitemap
(including image entries) and robots.txt.

## Search Console (knowledge platform, Stage 6)

`tests/search-console.test.ts` (47) covers the whole stage against a fixture at
the provider boundary, so none of it needs Google credentials — which is what
the boundary is for.

**The fixture** (`FakeSearchConsole`) implements `SearchConsoleProvider`,
records every request it was given, and pages exactly as Google does: `rowLimit`
rows from `startRow`, with a full page the only signal there may be more. Tests
that need a failure queue an answer (`UNAVAILABLE`, `NOT_CONFIGURED`) instead.
`setSearchConsoleProviderForTesting` swaps it in, as the research and payment
providers already do.

What is asserted: the unconfigured provider reporting `NOT_CONFIGURED` rather
than failing, the connection screen showing it without touching the database, a
sync refusing with an explanation and storing nothing, the scheduled job
reporting rather than failing, and an empty opportunity report rather than a
screen of zeroes; the Google provider being unconfigured without credentials
and never returning key material from its connection; a sync storing what came
back, an identical second sync writing nothing, a revised day updating in place,
a double click being one sync, a retried job returning a finished sync
unchanged, pagination across two requests, an outage recorded as a failed sync
with the watermark unmoved, the next window re-reading the trailing days,
another site's address dropped, an unrecognised page kept with no listing
attached, an old address resolved through the redirect table, and the job
running through the real registry; the five opportunity kinds, a position band
with too few pages reported as insufficient data instead of compared against, a
window whose predecessor is unmeasured not being compared, and no report
containing the words score, search volume, difficulty, CPC, backlink or
competitor; an opportunity decision stored without changing the finding; the
change history for a listing and for a shelf, its append-only trigger refusing
both an update and a delete, and two changes to one field keeping two rows;
before-and-after stating what the numbers did, never a causal claim (asserted
against five phrasings), a change too recent refused, and the same observational
wording for a fall; controlled learning recommending a phrase, creating no alias
and no fact, and stopping once the alias is approved; and every entry point
refusing a customer and a signed-out visitor.

**Not covered here:** whether Google's real responses match the shapes
`GoogleSearchConsoleProvider` parses. That needs credentials and is marked
UNVERIFIED in `docs/KNOWLEDGE_PLATFORM.md`.

## Stage 8 — the final audit's tests

Three new files, each written against a defect that was reproduced first, and two
of them able to catch a defect that does not exist yet.

**`tests/search-document-order.test.ts`** — the search document is built in a
declared order. The first test reads `refresh_product_search` as the database
holds it (`pg_proc.prosrc`) and fails when any `string_agg`, `array_agg` or
`jsonb_agg` in it can return rows in an arbitrary order; `DISTINCT` counts as
ordered, because PostgreSQL sorts to deduplicate. It is a source check for the
same reason `pkb-write-paths` is one: it covers aggregates written later. The
second test says what the order *is* — a shelf's own `sort_order` — and asserts
that refreshing one listing and refreshing it inside a batch store the same bytes,
which is what makes the derived model comparable to the canonical data behind it
(invariant I-21).

**`tests/knowledge-decision-concurrency.test.ts`** — real PostgreSQL, in the
`real-postgres` project. An approval and a rejection of the same alias are issued
together, six rounds; exactly one may win, the recorded decider must be the one
whose decision the row now shows, and nothing may be left `suggested`. Confirmed
to fail against the previous code, where both were fulfilled. Claim decisions sit
in the same file as the control: that path already loads its claims `for update`,
and the point of testing it beside the broken one is that it stays safe.

**`tests/prune.test.ts`** — a batched prune removes exactly what is past the
cutoff and counts it exactly; it stops at its ceiling and reports `more` rather
than appearing to have finished; it does nothing and says so when there is
nothing to do; and a caller cannot ask for a batch size below the floor.

Two existing files gained a case. `tests/pkb-intelligence.test.ts` now covers
re-assessing a resolution: a staff account holding `seo.view` but not
`catalog.manage` is refused, the confirmed identity it could have cleared
survives, and somebody who may manage the catalogue still can.
`tests/legacy-coverage.test.ts` covers the parked-value classification: a label no
attribute means is ambiguous, an identifier that failed its check digit is
unusable and is never counted as needing a decision, the report changes to
"placeable" **only** after somebody records what the label means, and reporting
writes nothing.

### Counts at the end of the programme

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` (both projects) | PASS — 109 files, 1,484 passed, 8 skipped, 261 s |
| `npm run build` | PASS |
| Playwright against that build (`E2E_PRODUCTION=1`) | PASS — 490 passed, 6 skipped, 0 failed |

The unit count rose from Stage 7's 106 files and 1,471 tests by exactly the
thirteen cases described above. The 8 skips are viewport-specific by design, and
the 6 end-to-end skips likewise.

### Checks that are not in the suite

Run by hand during the audit, with the figures in
`docs/KNOWLEDGE_PLATFORM.md` section 3G:

- Rebuilding `product_search` and `product_search_attributes` from canonical data
  and comparing every column, on the development and the 5,000-listing databases.
- Comparing the development database's schema against one built from zero by the
  migration chain.
- `npm run perf:search-console` on `manifest_bench` (1,120,000 measurements over
  20,000 pages) and `scripts/perf/knowledge-bench.ts` on `manifest_scale`.
- Probing a missing listing, a missing shelf and an unmatched route against
  `next start` for status, `robots`, canonical and structured data (R-18).
- Searching the built client bundles for anything that looks like a credential.

## Stage 9 — product preparation

`tests/product-preparation.test.ts` (20 tests). The enrichment worker is
deliberately not run: retrieval goes over the network, and a test that depends on
a manufacturer's website is a test that fails when that website changes. The
enrichment run is completed the way the worker completes it, which is what
preparation is waiting for, and the retrieval path itself is already covered by
`tests/pkb-net.test.ts` and `tests/pkb-intelligence.test.ts`.

What is asserted is mostly what preparation refuses to do:

| Case | Expected |
| --- | --- |
| A product created with a brand and a model number | HIGH_CONFIDENCE immediately, with no visit to Product Intelligence |
| Identity added later, then cleared | Re-assessed both times; UNRESOLVED again when the identifier goes |
| A GTIN whose check digit fails; two trade identifiers at once | Both refused at the save |
| An official address on the save | One `pkb_product_sources` row, and no claim, evidence or fact |
| A product with no identity | BLOCKED, and no enrichment run created |
| Two products sharing a brand and a model number | NEEDS_REVIEW, and no enrichment run created |
| No sources and no provider | BLOCKED with AUTOMATIC_SOURCE_DISCOVERY_NOT_CONFIGURED, and the provider's own state recorded |
| A staff URL, and separately a staff document | The run carries on in both cases |
| A document that proposed values | NEEDS_REVIEW with CLAIMS_WAITING; every claim still SUGGESTED, no fact written |
| A thin listing | NEEDS_REVIEW with INSUFFICIENT_KNOWLEDGE, and no research run at all |
| A filled listing | READY, all seven steps recorded, and the knowledge base's fact count unchanged by the generator |
| The same request key, and a second click | One run, both times |
| A retry | No second enrichment run, claim or evidence row |
| A provider that fails | BLOCKED, with the product's knowledge untouched |
| A customer | Refused at every entry point |
| A staff-entered value and an unaccepted claim | The first reaches `loadPulseInput().knowledge`, the second does not |
| Anything a run reports | No stack trace, no raw error; a message and a remedy on every failure |

## The Intelligence workspace (Stage 11)

`tests/intelligence-workspace.test.ts` (14 tests) covers the reads and the
rules, against a real database.

| Case | Expected |
| --- | --- |
| The owner opens Intelligence | All seven tabs offered, in order |
| Marketing opens Intelligence | Overview, SearchPulse and Search Console only — no catalogue tab |
| Order manager, support, finance, a customer | No tab at all, so no Intelligence entry |
| The workspace gate | Exactly the permissions its tabs ask for, and no role widened |
| Every deep-link parameter | A known value accepted, an unknown one ignored, `?days` clamped to 7, 30 or 90 |
| Each SeoPulse filter | Maps to the stages the backend actually stores, and returns only those runs |
| Preparation counts | One row per stage from `preparationSummary`; a stage with no runs is absent, not zero-filled |
| A failed run on screen | The backend's own message, never an error string |
| Knowledge counts | Identity states, suggested sources and brand relations counted from the tables; approving a source removes it from the count |
| Every workspace read | A customer and a staff role without the permission are both refused |

`e2e/intelligence.spec.ts` (11 tests per project) covers the browser
behaviour consolidation can break.

| Case | Expected |
| --- | --- |
| The admin navigation | One Intelligence entry; Search, SEO Pulse, SEO health, Search performance and Knowledge gone; Orders, Products, Background work, Analytics and Settings still there |
| Each tab clicked in turn | The right route, the right heading, `aria-current="page"`, and back/forward moving through them |
| A refresh on `?severity=required` | Same tab, same filter, same heading |
| An overview card clicked | The tab that lists what it counted, already filtered |
| `?filter=nonsense` | The tab, unfiltered — not an error |
| Search Console with nothing connected | "Search Console not connected", an explanation, no provider enum on screen, and the rest of the workspace still usable |
| The five old addresses | Still answer, each saying which tab it is now |
| `/admin/search?days=90` | Still works, still at that address |
| `/admin/products/[id]/intelligence` and `/admin/jobs` | Still their own destinations |
| A marketing account | Three tabs offered, four absent; typing a forbidden tab's address redirects; the API behind it answers 403 |
| Every tab at 320px | No horizontal page overflow, and the last tab reachable by scrolling the tab row |

## SeoPulse generate and regenerate (D-120)

`tests/seo-pulse-regeneration.test.ts` (real database, rules generator):

| Case | Expected |
|---|---|
| SeoPulse writes A, staff edit to B, knowledge improves, SeoPulse prepares C | B unchanged through Fill and the job queue; Regenerate refused (409); only `replaceStaff` writes C, and the history records it |
| SeoPulse writes A, nobody touches it, knowledge improves | Regenerate writes C with one click; history "Regenerated with SEO Pulse" with the run id; the field stays SeoPulse's |
| A locked field | Never replaced, even with `replaceStaff` |
| A run older than the latest | Refused |
| Saving a section without changing the field | Does not take the field over |
| A value no history accounts for | Counts as staff's |
| SeoPulse's own description and features | Do not count towards sufficiency |

`e2e/seo-pulse-regeneration.spec.ts`: the editor offers Regenerate for
SeoPulse's own description and Keep / Review / Replace for staff's. Replace
appears only after review. A customer calling the regenerate API gets 403.
`tests/manufacturer-shop-page.test.ts` pins Case B's regenerated wording.

## One-click Prepare with SeoPulse (D-122)

`tests/one-click-preparation.test.ts` (real database, rules generator, the
enrichment worker completed the way the worker completes it — no live site):

| Case | Expected |
|---|---|
| New product with enough established fact, empty content | One run to READY with steps identity → … → content → listing → search → page; description, key features, SEO title, meta description, focus keyword, tags and search terms written; history "Prepared with SeoPulse"; every field SeoPulse-owned; no recommendation left; no Fill called |
| Specifications | Established facts reach the editor from the knowledge base; the finished summary reads all done |
| Search and page | The listing leaves the search queue within the run; the page step records its check counts |
| READY vs publishable | Required publish checks (photograph, price) still fail |
| Staff-written description | Kept; reported as kept; "1 recommendation needs your decision" |
| SeoPulse wording edited by staff, product prepared again | Kept |
| SeoPulse wording untouched, knowledge improves, prepared again | Refreshed; both versions in the history |
| Source about another product | Stops before generation; no research run for content; Continue with corrected identity resumes the same run to READY |
| Values waiting for review | Stops; nothing generated or written |
| Too little known | Stops with no filler; Continue with another address researches again in the same run; specifications added by hand + Continue reaches READY in the same run |
| Background service offline | The same run is returned to every retry and carries on later |
| Double click (concurrent) | One run |
| Listing step retried after a crash | No second history row, no second generation |
| Retry / Continue on a finished run | No second research run, no second generation |
| Prepare again | A new run only after the previous one finished |
| Page re-read repeating accepted values | Claims SUPERSEDED, run finishes; a changed value is a CONFLICT and stops |
| Fill | Still works for the manual path |
| Permissions | `applyPreparedContent`, start and continue refuse a customer |

`tests/preparation-presentation.test.ts` adds the finished summary and the
decision count. `tests/real-source-pipeline.test.ts` now expects a re-read
repeating staff-entered identity to be SUPERSEDED, never accepted.

`e2e/product-preparation.spec.ts` adds one browser test that presses Prepare
with SeoPulse once, drives the scheduler through `/api/cron/jobs`, and checks
the success card, the Before publishing list, Refresh with SeoPulse, the
hidden Fill button and Advanced details.

## Source-grounded extraction and family-aware sufficiency (D-123)

`tests/source-grounded-extraction.test.ts` (pure, 36 tests) and
`tests/source-grounded-pipeline.test.ts` (PGlite, 11 tests). Fixtures:
`tests/fixtures/revlon-colorsilk.html` — the real Revlon page, trimmed, with its
JSON-LD cut to five of 48 shades — and `tests/fixtures/northfield-barrier-cream.html`,
a fictional skincare page, so nothing passes because of hair colour. The
pipeline test replaces `safeFetch` and robots.txt with the fixtures
(`vi.mock`) and the extraction provider with a scripted one; nothing reaches
the network.

| What | Where |
|---|---|
| Structured readers alone: sections, selected shade, variant group, no "Step 1" labels, no reviews | extraction |
| Provider not called when the structured readers found enough | pipeline |
| Prose facts found and kept with the page's excerpt as evidence | extraction, pipeline |
| Excerpt not on the page, unsupported number, unsupported word, unsupported yes/no — rejected | extraction |
| Identity, marketing and price never taken from a model | extraction |
| New label → proposal with the reading's suggestion | pipeline |
| Family created on the first "Add to family"; the next shade reuses mapping and ignore | pipeline |
| Product-only fact kept | pipeline |
| "Shade 10", "10", "(1N)" not identity; real model codes still identity | extraction, pipeline |
| Brand + exact name + version identifies; a vague name does not | extraction, pipeline |
| Page showing another shade: its selected shade not used; unresolved version → nothing used | extraction, pipeline |
| Barcode stated only as a SKU matches; a different declared barcode still mismatches | extraction |
| Discovery by brand + exact name; vague identity not searched | extraction |
| Family-aware sufficiency: mouse (required attributes), hair colour (no measurements), empty schema (gap), identity only, offer terms | extraction |
| Skincare product judged by its own family after reading the fixture | pipeline |
| No generic SEO title/snippet when research is incomplete; whole statements when it is | extraction |
| Fill writes no SEO title or meta while insufficient; staff meta untouched | pipeline |
| "Previous SeoPulse content" only for SeoPulse's own wording, never staff's | extraction |
| AI-assisted values need the owner's opt-in policy to verify | pipeline |

The Glorious regression is the existing `manufacturer-shop-page` and
`real-source-*` suites, unchanged except two assertions that encoded the old
sufficiency rule (identity counted as facts; two facts plus identity were
enough). Real acceptance on `preorder_utf8` is recorded in PROGRESS.md.

## Local research and AI (D-124)

No permanent test reaches a real website, Ollama or SearXNG. Ollama and SearXNG
are replaced by fakes on loopback ports (`tests/helpers/fake-ollama.ts`), pages
by fixtures, and `safeFetch` by a fixture map where a database test reads pages.

- `tests/local-ollama.test.ts` — the loopback rule, model detection, structured
  requests with no key, one bounded retry then FAILED, grounding of a local
  model's answer (made-up fact, unsupported number, another version rejected),
  provider selection with no paid key and no cloud fallback, DataForSEO off
  while local, SeoPulse's grounded view, `sanitizeGenerated`, and withheld
  figures. Phase B (D-126) added:
  - streamed answers, and a broken, erroring or unfinished stream used as
    nothing;
  - only the product's own site synonyms shown to the model;
  - SeoPulse's own earlier search terms hidden from the model;
  - " · Manifest" removed from titles.

  The fake Ollama (`tests/helpers/fake-ollama.ts`) streams NDJSON when asked
  to, as the real one does. Live acceptance against a real Ollama and SearXNG
  is recorded in PROGRESS.md, "Phase B"; it is not part of the automated
  suite.
- `tests/local-research.test.ts` — sitemap and index parsing, gzip, robots
  declarations, bounded traversal, the per-domain cache, identity ranking (GTIN,
  model, brand + name + version; unrelated and vague ignored), SearXNG JSON,
  JSON disabled, unavailable, official domains first, snippets as notes only.
- `tests/local-health.test.ts` — Ollama, SearXNG and Playwright health states,
  the health cache, the setup panel with every service stopped, and which
  related links are followed.
- `tests/local-browser-render.test.ts` — a real headless Chromium (skipped when
  it is not installed) renders a JavaScript-only fixture on `127.0.0.2`. The
  page tries to reach an internal server; the server must see no connection.
  Also: navigation away is refused, an internal start address is refused, the
  browser is closed, and the launch flags alone block loopback. Removing the
  flags lets Chromium connect to the loopback server (checked by hand).
- `tests/local-pipeline.test.ts` — against a real database: a beauty page
  (Revlon fixture) read by the fake local model and grounded; a technical page
  whose specification page is followed; a skincare product found in an
  official sitemap and by local search; a JavaScript-rendered serum; Prepare
  with SeoPulse on the local model, with staff and locked fields kept; Ollama
  down leading to a rules-labelled run; and no paid key anywhere. D-127
  added: preparation keeps one `seoRunId` and waits while it is queued and
  while it is generating, then resumes from that run (no second generation);
  a live wait outlasts `MAX_TICKS`; a dead job stops the run. The final
  write boundary is tested by committing a change after every earlier check
  (`setBeforeFinalContentCheckForTesting`): a reopened identity, a new claim
  and a new unmapped label each write nothing; a description saved and a
  field locked at that moment stay byte for byte; unchanged knowledge still
  writes.

## Local AI runtime (D-127)

Fake Ollama answers can be delayed (`delayMs`), and the fake counts how many
chat requests it serves at once. No test waits the minutes a real generation
takes: thresholds are tested with fake clocks.

- `tests/local-ai-runtime.test.ts` — Ollama runs in the background and the
  rules generator inline; a hosted model stays in the background; a queued run
  sends nothing to the model; a live run refuses a second and can be joined; a
  dead job's run is closed. `seoRunPhase` at 3 and 10 minutes, stalled and
  abandoned, and the inline window. `localAiRuntime` from
  `OLLAMA_TIMEOUT_MS`. Per-kind recovery (local kind kept at 20 minutes and
  recovered after its window, default kinds unchanged, no policies without a
  local model) and the heartbeat. The slot: never two model calls at once,
  released after an exception and a timeout, `OLLAMA_QUEUE_WAIT_TIMEOUT`, one
  local-AI job per lane with the next left queued, and never in an ordinary
  batch. Failure codes for unavailable, missing model, timeout and malformed,
  and a rules fallback recorded with `fallbackFrom`.
- `tests/local-ai-concurrency.test.ts` (real PostgreSQL) — the slot is
  refused while another connection holds it, freed when that connection
  dies, and allows exactly `LOCAL_AI_CONCURRENCY` holders. The final check
  waits for a knowledge change holding the knowledge lock and then sees it.

## Product data and SeoPulse quality (D-128)

Synthetic products from unrelated families (a graphics card, a perfume, a
lamp, a shoe-like row) — no rule under test names a brand.

- `tests/data-quality.test.ts` (pure) — units written once, added once, and
  technical symbols, dimensions, ranges and compound values untouched;
  calls to action, navigation, promotional modules and decoration refused
  while real rows, numeric or not, and unfamiliar plausible rows pass; the
  warranty policy and its reach (facts, At a Glance, Key Points, generated
  text) with the manual warranty allowed; At a Glance as short label → value
  in family order and Key Points as readable lines that never repeat it; a
  simple family gets no technical sections; bulk selection (visible and
  actionable only, hidden selections never acted on, groups of 100, first
  refusal stops the rest, the message); SKU length, model and variant use,
  stability, collisions, Unicode; language verdicts for English, German,
  French, Spanish, Chinese, Japanese, Arabic, Bengali, mislabelled pages,
  mixed footers, thin pages, hreflang, locale ranking and product names; the
  quality gate (exact title once, evaluative claims, filler, a word the facts
  use, third restatement, doubled units, foreign sentences, withheld
  description with other fields kept, empty sections, meta boundaries,
  stuffed title, concise simple product, search terms).
- `tests/verification-and-sku.test.ts` (database) — bulk accept and reject
  through `acceptClaims`/`rejectClaims` with per-claim decisions and the
  audit row listing every claim; a group with a stale claim refused whole;
  customers refused; no verified acceptance without a policy; more than 100
  refused. Generated SKUs for a long title, with a model number and variants
  (MPN left in its own field), for a duplicate identity (-2), after renaming
  option values (generated SKU follows, staff SKU byte for byte), and for a
  duplicated product (within 64).
- `tests/local-pipeline.test.ts` (database, fake fetch and Ollama) — an
  English official page read without its furniture, decoration or warranty,
  its text kept for provenance, the manual warranty untouched; a German
  official page refused as NON_ENGLISH_SOURCE, never shown to the model, and
  its English hreflang version read instead; a thin page refused as
  LANGUAGE_UNCERTAIN; a German pasted document refused; a messy local answer
  written into the listing clean through preparation (one model call,
  localGrounded kept, title withheld, meta ends naturally); the model shown a
  bounded plan and only the manual warranty.
- `e2e/claim-review.spec.ts` — select one, select all shown, clear, an empty
  filter, accept one, reject the rest, on phone and desktop; no sideways
  scrolling at 360 px.

Existing assertions that encoded "Label: value" key points were updated to the
new phrasing ("1000 Hz polling rate").

Added after live runs with `qwen2.5:7b` (each case is a shape the real model
produced): "Experience the power of …" openers, "high-performance" and
"High-End …" titles, praise as tags, a brand containing an evaluative word,
"smoothly"; `withoutPraise` taking an attributive adjective out and fixing
"a"/"an", and refusing predicative praise, pairs ("compact yet powerful"),
degree words ("a more immersive"), prepositions ("Perfect for …"), "most …"
and too-short results; any "Label: value" key point rewritten, including a
label the facts do not use.

## SeoPulse content polish and live English-only checks (D-129)

Invented products from unrelated families (a graphics card, hiking boots, a
perfume, a dining table, olive oil, earbuds, a floor lamp). The title-fit
source is checked to name none of them.

- `tests/seo-content-polish.test.ts` (pure) — SEO titles: a long name fits
  the 49-character aim (60 at most), whole words only, "12 GB" kept together,
  no dangling "for"/"with", the product type kept whole ("Graphics Card", not
  "Graphics"), brand, model codes and variant values kept, praise, repeats and
  asides removed first, the site's name removed once whatever the separator,
  two variants (size 10/11, 12GB/16GB) kept apart, a short name unchanged, and
  the same function used by the rules title, `sanitizeGenerated` and the
  quality gate. Opening: a safe opening unchanged, a praised one repaired, an
  unrepairable one replaced by "<name> has <fact> and <fact>.", the product
  named in the first sentence, no praise, warranty or unestablished figure in
  the opening, "This is the <name>." when no fact reads well, and the full name
  not repeated afterwards. Thin sentences: a factual clause kept when its
  neighbour loses its praise, empty sentences dropped (with or without praise
  to begin with), short plain sentences and unusual factual wording kept. Rules
  meta: one sentence, not a list, the highest-ranked facts, fewer when fewer
  fit, no company label, measurement, count or raw data key (found live),
  "for <use>" only when stated, plural verb for a plural name, a clean
  ending within 50–160 characters, no praise, sales call or warranty, used in
  English when a model's (filler and German) meta is refused, and withheld
  when no fact reads well. Live-found: `/gb-en/` and `/sg-en/` rank as English,
  `/pl-pl/`, `/ca-fr/` and `/pt-br/` do not.
- `tests/local-pipeline.test.ts` (database, fake Ollama) — through Prepare with
  SeoPulse: an unrepairable opening and an empty praised clause become a named
  opening and the factual clause, and a refused meta becomes the one-sentence
  rules meta; a staff-owned and a locked meta description are each left byte
  for byte when the model's meta is refused.

Changed: `tests/source-grounded-extraction.test.ts` expected the old rules
meta ("… inside out." — the manufacturer's statements run together); it now
expects the one-sentence form.

Live, not automated (scratch scripts and logs in `.scratch-acceptance/d129-*`,
untracked): real SearXNG discovery and one bounded research run per product
through the normal pipeline with a recording document reader, and one real
SeoPulse generation with `qwen2.5:7b` (PROGRESS.md, D-129).

D-129A adds to `tests/seo-content-polish.test.ts`: "delivers performance" not
left behind; the factual clause kept beside it; a cooling system kept without
"to ensure performance and stability"; a figure elsewhere in the clause does
not exempt the predicate; real objects ("28 Gbps memory speed", "100W
output", "4K at 120Hz", "four USB-C ports", "a performance of 800 lumens")
untouched; no replacement relationship written; a sentence left meaningless
dropped. The same for sentences with no praise at all ("delivers performance
for 4K gaming", "a cooler that ensures stability", "It provides quality."),
real objects and sentences without such a predicate kept byte for byte, "ensures
stability" kept when a fact states it, and an opening removed this way given
the plain opening.

D-130 — `tests/seo-title-identity.test.ts` (pure, 22 tests): product type from
the family, a specific category, a recorded product type and, only without
those, the listing's own words; a category with children, a leaf with no
family the title does not name, and levels above the product's category not
taken for the type; a packaging tail and a fact-stated container not taken
for the type; unknown rather than a guess; no brand or kind of product in the
code. Titles: a fitting name unchanged; a packaging tail and praise go before
identity; a model code, its suffix ("Ti") and the model's name word kept;
capacity, shade, size, generation and variant-level facts kept; no cut inside
a word or code and no half type; the site's name once; 128GB/256GB, Shade
120/150, 50/100 ml, Gen 2/3, Wi-Fi/Wi-Fi + Cellular and a model suffix never
shortened to the same title; a critical identity of 60–70 characters kept
whole, and past 70 the type and whole codes go before a variant's value; a
sanitised model title fitted the same way. Grammar: names ending in Series,
Lens, Headphones, Jeans and Edition read the same; one, two and no facts;
filtered facts leave no dangling "and", stray punctuation or doubled space;
staff lines as "key features"; a stated use; the full name once; the bare
identity sentence only when nothing names the product. D-129 assertions in
`seo-content-polish.test.ts`, `local-pipeline.test.ts` and
`source-grounded-extraction.test.ts` updated from "has/have/features" to the
new wording.

## End-to-end variety listings and running on a hard disk (2026-10-02)

`e2e/seed-variety.ts` adds six listings to `preorder_e2e` only (never the
development catalogue), on a shelf of their own, and
`e2e/catalog-variety.spec.ts` asserts on them: the shelf count and the draft's
absence, what each card says (stock, out of stock, sale price and saving),
buying from stock, the out-of-stock reason, low stock with a sale, a
143-character title at 320 px, a deposit, a listing with nothing optional,
and a draft unreachable by address, search and suggestion.

Three sizes of data, three tools:

| Size | How | For |
|---|---|---|
| Small (30 listings) | `npm run test:e2e` — `db/seed.ts` + `e2e/seed-variety.ts` | Browser tests |
| Medium | `DATABASE_URL=…/manifest_scale npm run db:seed:scale -- --create --reset --products 500 --customers 2000 --orders 10000` | Looking at a busy catalogue by hand |
| Large | the same with the defaults (5,000 / 20,000 / 100,000) | `npm run perf:bench`, `perf:http`, `perf:search-rebuild` |

The scale seed refuses any database not named as scratch. Playwright is not
the load test: races, idempotency and throughput are the
`tests/*-concurrency.test.ts` suites and `scripts/perf/`.

On this machine the repository is on a hard disk. After a reboot, read the
dev cache once before the first run, or the web server does not answer within
its three minutes:

```sh
find .next/dev -type f -print0 | xargs -0 -P 4 -n 64 cat > /dev/null
```

A test that types one key at a time (`pressSequentially`) waits for the page
to settle first (`openHome` in `search.spec.ts`): keys typed before the header
box hydrates are lost.

## Staging infrastructure (D-132, D-133)

No test sends an email, calls a real model or opens a connection beyond
loopback.

| Suite | Covers |
|---|---|
| `tests/notification-smtp.test.ts` | Email settings and what is refused; the message as nodemailer composes it (sender, one recipient, plain text, stable Message-ID, one-line subject); the allow-list; SMS refused; failures recorded by kind with no setting in them; provider health |
| `tests/notifications.test.ts` | Added: waits between retries and an outage of two hours survived; a permanent failure stops at once; the same idempotency key on every attempt |
| `tests/remote-services.test.ts` | Remote use is opt-in; private-or-https; the gateway token sent and a refused one reported as unavailable; SearXNG through a gateway; the slot refusing a pooled address; concurrency 1 by default |
| `tests/worker.test.ts` | A worker tick schedules, runs, retries and records the heartbeat; the loop overlaps ticks up to its ceiling and survives a failing one; `/api/cron/jobs` declines under `JOB_RUNNER=worker`; cache tags collected, forwarded, kept on failure, and validated by the route; the health report's counts and that it carries no secret; the setup panel reading the worker's report |

`npx tsx scripts/jobs/worker.ts --check` is the check that the worker's
module graph loads outside Next.js; it reads and writes nothing but the
health queries.

## Staging readiness (D-134)

| Suite | What it proves |
|---|---|
| `tests/staging-readiness.test.ts` | Connection modes (Neon's `-pooler`, a declared mode, loopback, unknown); a declared transaction pooler refuses the slot and turns prepared statements off; `EXPECTED_DATABASE_NAME` and the names never accepted as staging; the read-only migration status; the staging check's report per role, including that it prints no value; refusal reasons that never name a host; the worker's gate on the model's service; Blob prefixes keeping environments apart; the worker container's liveness check |
| `tests/session-lock-concurrency.test.ts` (real PostgreSQL) | The session-lock test passes on a direct connection and catches an imitated transaction pooler, leaving no lock; the worker's database check (identity, declared pooler, lock); the staging check's database report (ready, test database refused, no ledger, unreachable) without writing; `db/migrate.ts` refusing another database before writing, and migrating the expected one |
| `tests/local-ai-runtime.test.ts`, "the worker's lane while the model's service is down" | A SeoPulse run stays queued while Ollama is down, is claimed when it answers, runs as rules with `fallbackFrom` after the wait, does not wait with 0 or for a refused address; ordinary jobs never wait |
| `tests/local-pipeline.test.ts`, "a document staff provide, where a worker runs the jobs" | A provided document is not sent towards a private model from a web request under `JOB_RUNNER=worker`, the structured reading stands, and the worker's own process still uses the model |
| `tests/worker.test.ts` (added) | The loop marks itself alive on every pass and survives a liveness write failing; health reports the connection mode |

Not automated (run by hand, PROGRESS.md): the SMTP adapter against a local
STARTTLS capture server; `npm run staging:check` and `worker --check`
against a disposable `manifest_staging_verify`; the repository's SearXNG
settings in a real SearXNG.
