# Decisions

Architecture decision log. One entry per meaningful choice, newest first. Each entry states the decision, the alternatives considered, and why the decision won — so a later session can revisit it without re-deriving the reasoning from scratch.

---

## D-040: Product-owned variants, one-page editor, one-click SEO Pulse

**Decision:**

- **Variant options belong to a product.** `attributes.product_id` (migration
  0020). "Color" on Sofa A is Sofa A's own option with its own values; a new
  product starts with none; removing a value removes only that product's
  variants that carry it (archived where they have order history) and never
  warns about other products. Options are created from the editor
  (`createProductOption`), not from a shop-wide list. Existing shared options
  were converted per product by `scope_product_attributes()`, which the seed
  also calls. Storefront filters and search group options by *name*, so two
  products' "Color" still filter together.
- **Variant photos** use the existing `variant_images` table: a variant points
  at one of the product's photographs (or one uploaded from the variant row);
  the storefront gallery shows it when that variant is chosen.
- **One page, not tabs.** The editor is a single column of sections — Basic
  information, Media, *Variants, pricing & inventory* (one compact manager:
  groups as chips, one row per variant that opens into its editor, folded
  after 8 rows / 6 chips), *Product information* (description and key
  features, specifications, search & SEO together), and the optional
  Warranty & safety and Visibility & schedule, folded. A narrow right column
  holds two small boxes: SEO Pulse and "Before publishing". The sticky action
  bar stays. "Fix →" jumps scroll to the section and focus the field.
- **SEO Pulse is one button** ("✨ Fill with SEO Pulse", `fillWithSeoPulse`):
  it saves unsaved edits, researches (reusing research on an unchanged
  product), and writes into *empty* fields only — focus keyword, SEO title,
  meta description, a factual starter description, key features (AI only),
  and adds tags and search terms. It never replaces the admin's text, never
  writes photo alt text (it cannot see photos), and lists the facts only the
  admin can supply (dimensions, weight, material…). Scores, keyword analysis
  and recommendations appear only in the downloadable report. The large
  SEO Pulse tab was removed.
- **Internal search terms** now include how people shorten names:
  "3rd Generation" → "3", the model family ("AirPods Pro"), brand + family
  ("Apple AirPods") and brand + category type ("Apple earbuds").

**Required fields (marked *):** product name, category; at least one photo;
per variant a price and SKU, plus stock (in stock) or places and a closing
date (preorder). These are exactly what the publish check enforces.

**Not added:** no new product fields. SEO Pulse fills existing ones.

## D-039: Products admin — publish from the list and a sticky editor bar

**Decision:** Publishing is no longer only the setup wizard's last step. Every
draft row in Admin → Products carries a visible **Publish** button beside
**Edit**, and every product editor has a sticky action bar: *Save draft ·
Preview · Publish now* for a draft, *Preview · Update product* for a live
product, *Restore as draft* for an archived one, with Duplicate, Unpublish,
Archive and Delete under ⋮. Publishing always goes through the same server
readiness check (`publishProduct`); a refusal now returns each failing check,
and the bar lists them with a link to the section that fixes it.

- **One notion of "published"**: not archived and in `PUBLIC_STATUSES`.
  "Draft" in the list includes `scheduled`. When no status is chosen, a
  product is published as `preorder_open` if it has a preorder variant, else
  `in_stock` (`inferLiveStatus`); the Visibility tab changes how a live
  product is offered, through the same check.
- **The Basics status dropdown is gone.** It could set a live status without
  the readiness check. Status now changes only through publish, unpublish,
  archive and restore.
- **New actions**: Unpublish (back to draft), Duplicate (new draft; photos,
  categories, options and variants copied; SKU, trade identifier, stock and
  reservations not), Delete (permanent, only when nothing ever depended on
  the product — no orders, reviews, stock movements, waitlist or reserved
  places; otherwise refused with "archive it instead"), staff Preview of an
  unpublished product (`/products/<slug>?preview=1`, checked against
  `catalog.manage`, noindex, with a "not visible to customers" banner).
- **Inventory states in the list**: *Out of stock* — has variants and none can
  be bought (no units, no places, no uncapped preorder); *Low stock* — a
  variant at or below its low-stock line, **3 when none is set**, or a capped
  preorder with 1–3 places; *No variants*.
- **Editor sections** are numbered and ordered as the work is done: Basic
  information, Description, Media, Variations, Pricing & inventory,
  Specifications, Warranty & safety, SEO & search, SEO Pulse, Visibility.
  Variations and pricing are now inside the editor (the separate variants
  page and the wizard remain).
- **Saving stays per section** (each panel saves only its own fields, D-037
  era design). The action bar's Save/Update submits every unsaved section at
  once and reports any that failed; it also warns before leaving with unsaved
  edits (Stay / Leave without saving / Save changes).
- **After Add Product** the admin lands in the editor, not the wizard.

**Assumptions for the owner:** low-stock default of 3; bulk inventory editing
is not offered (per-variant stock is edited on Pricing & inventory).

## D-038: SEO Pulse — research and recommendations, applied only by staff

**Decision:** SEO Pulse is an admin-only layer in `lib/seo-pulse/`. A run
loads the product as saved, collects research, writes recommendations, and
stores everything as one versioned row in `seo_research_runs`. Staff review
and edit the recommendations in a new "SEO Pulse" tab of the product editor
(and under the SEO step of the setup wizard), then apply the ones they choose.
Nothing is written to a product until they do.

- **Two provider interfaces.** `SeoDataProvider` (keyword volume, difficulty,
  CPC, trend, Google results) and `SeoIntelligenceProvider` (writes the
  recommendations). Implementations: DataForSEO for data, Claude via the
  official Anthropic SDK for AI, and a rules generator that needs neither.
  Both are selected by environment variables read in
  `lib/seo-pulse/config.ts`; the default is rules + no external data, so
  nothing costs money until someone opts in.
- **Research and analysis are stored apart.** `research` holds only what a
  source returned, each figure with its source and date; `analysis` holds only
  recommendations, labelled with what generated them. With no data provider,
  volume/difficulty/CPC are "Data unavailable" — never estimated.
- **First-party research is always available.** The site's own search log
  (`search_queries`, `search_clicks`) supplies real queries, zero-result
  counts and typos the search corrected. Misspellings are only proposed from
  that log (rules) or marked AI-suggested.
- **Facts are not generated.** Content gaps, identifiers, structured-data
  readiness and both scores are computed from the listing by fixed code, never
  by the AI.
- **Field mapping, reusing what exists:** primary keyword → new
  `products.seo_focus_keyword`; SEO title → `seo_meta_title`; meta description
  → `seo_meta_description`; slug → `slug`; H1 → `title` (the product page
  heading is the product name, so there is no separate H1 field); description
  → `description_html`; tags → `tags`; search aliases, misspellings, phrases
  and brand variations → `search_keywords` (the existing internal-search
  field); synonyms → a new site-wide `search_synonyms` entry (needs
  `search.manage`, off by default, never edits an existing entry); image alt
  text → `product_images.alt_text`. FAQs and content gaps are shown, not
  stored — there is no FAQ field on the product page, and adding one would be
  a product-page redesign.
- **No silent overwrite, enforced on the server.** A field that already holds
  a value is only replaced when the request names it in `overwrite`. A list
  may grow without that flag but not shrink. Any conflict refuses the whole
  apply. The product is saved through `updateProduct`, the same path as the
  editor's Save.
- **Cost control.** Research never runs on page load. Each click carries a
  request key (unique in the table), so a retried request returns the same
  run; unchanged products reuse research under 30 days old unless "Run fresh
  research" is chosen; one run per product at a time; 30 runs per staff member
  per hour (`SEO_PULSE_MAX_RUNS_PER_HOUR`); a paid run asks first. Provider
  requests, tokens and reported cost are stored per run.

**Alternatives considered:** separate tables for keywords, sources,
recommendations and versions (the brief's list). One row per run with typed
JSON is simpler, keeps a run immutable as a unit, and exports as-is; nothing
queries individual keywords across runs yet. Revisit if cross-product keyword
reporting is wanted.

**Assumptions for the owner:** research counts as outdated after 30 days;
"price in Bangladesh" is offered as a long-tail keyword because this shop
sells in Bangladesh; the H1 recommendation renames the product only if Replace
is chosen; the scores are completeness checks with the weights in
`lib/seo-pulse/scores.ts`, not a ranking.

**Unverified:** the DataForSEO and Anthropic providers were written against
their documented APIs but never called — no credentials were available.
Both fail safe: an error is recorded on the run and the rules generator is
used.

## D-037: Product SKUs are reserved on the server when Add Product opens

**Decision:** Opening Admin → Add Product asks the server for a SKU, which is
generated and held in `sku_reservations` (`reserved`) for that admin for two
hours, renewed whenever the form is reopened. Saving the product turns the
hold into `finalized` in the same transaction as the product insert; that row
is permanent, so the SKU is never generated again — not after archiving, and
not after the product's SKU is edited (the old one is recorded too).
Cancelling releases it (`released`), as does expiry (swept before every
generation and by the scheduled maintenance job). Generation takes a Postgres
advisory transaction lock and picks the lowest free number, so concurrent
admins never share a SKU and released SKUs come back into use; a partial
unique index on held SKUs is the database's own backstop. Format
`SKU-000123`, defined by a replaceable `SkuStrategy` in `lib/catalog/sku.ts`.

**Why:** The product row is only created on save — there is no pre-save draft
in the schema — so the hold itself is the draft's claim, and the browser keeps
only its id (localStorage) to come back to the same SKU after a refresh or a
closed tab. The browser can never name a SKU to claim. Staff may still type
their own SKU; it is validated against products, variants, other admins' holds
and every permanent SKU, and the unused hold is released. Variant SKUs keep
their existing slug-based scheme and are checked against the same pool.

**Assumptions for the owner:** two-hour hold; lowest-free-number reuse.

## D-036: The admin inbox is read live from the records, with one "seen" timestamp per person

**Decision:** Admin → Notifications gains an inbox (new orders, orders unpaid
after a day, cancellation requests, failed customer messages, stock and
batches running out, new customers, pending reviews). None of it is stored as
a notification row: each item is queried from the record that proves it, and
each source is included only for a role that could act on it. The only stored
fact is `users.admin_inbox_seen_at`; an item newer than it is unread. "Mark
all as read" moves it to now. Stock alerts are levels, not events, so they are
never "unread". The existing outbox of customer email/SMS moved to a second
tab, "Customer messages".

**Why:** A separate notifications table would need writers in every code path
that creates an event and could disagree with the data; reading live cannot.
Per-item read state was judged not worth a table at this size — revisit with a
`admin_inbox_reads(user_id, item_id)` table if staff ask to mark single items.

## D-035: Homepage campaigns — one record per slide, hero and four tiles together

**Decision:** The single hero (`home.hero`) and product-slug showcase
(`home.showcase`) are replaced, as what the storefront reads, by one
`site_settings` row `home.campaigns`: five slots, each a hero image, focal
point, destination, optional headline/text/button, header contrast mode, a
new-tab flag and four tiles (image, title, destination, on/off). The first
read converts the old keys into slide 1 (borrowed product photographs carry no
media key, so they are never deleted). Only a slot switched on *with* a hero
image reaches the storefront; switching on an image-less slot or tile is
refused; removing a hero switches its slot off. Destinations accept a path on
this site or an absolute http(s) URL — anything else (`javascript:`, `//host`,
`data:`) is refused server-side. Images are uploads only. Writes need
`homepage.manage`. The slider does not auto-rotate.

**Why:** The owner asked for hero and showcase to be one promotional unit that
changes together; storing them as one record makes it impossible for them to
drift apart. A dedicated table was considered; the homepage is still
configuration read in one piece, and `site_settings` already carries the audit
trail. Tile images are the tile's own, not a product's, because the owner
wants promotional imagery independent of listings.

**Assumptions for the owner:** no autoplay (accessibility); "open in a new
tab" applies only to off-site links; with every slide off, the homepage builds
a temporary slide from the catalogue rather than showing nothing.

## D-034: Seven staff roles as named permission lists; staff password minimum 8

**Decision:** Roles stay one column on `users`. The permission table in
`lib/auth/authorize.ts` maps each role to capabilities (`catalog.manage`,
`homepage.manage`, `search.manage`, `reviews.moderate`, `orders.view`,
`orders.manage`, `customers.view`, `notifications.view`, `analytics.view`,
`finance.view`, `audit.view`, `staff.manage`, `settings.manage`). Roles:
Owner (`super_admin`, everything), Operations manager (`staff_admin`, exactly
what it had before), Product manager, Order manager, Customer support,
Marketing, Finance. Every gated `lib/` function asks for one permission;
every admin page calls `requireAdminPage(permission)`; the nav is filtered by
the same table. Money (sales, AOV, margin) is computed only for
`finance.view`. Staff temporary passwords need 8 characters (customers still
10). The "Change to" buttons are replaced by a role select and a separate
"Remove access".

**Why:** A permissions table in the database would let roles be edited at
runtime, but nobody has asked for that and it adds a way to lock everyone out.
Named lists in code are reviewable and testable. Analyst was folded into
Finance and Content into Marketing — separate roles would have identical
permissions.

## D-033: Coupons and zone-based delivery charges are deferred, not built

**Decision:** The gap audit found no coupon system and no Dhaka/outside-Dhaka
delivery pricing. Neither was built.

**Why:** Both change what a customer pays. The shop's founding promise is one
landed price with nothing added at checkout (D-010), and the deposit, balance,
refund and cancellation paths all assume the order total is the sum of the
variant prices. A discount line or a delivery charge has to be threaded
through every one of those, and whether to offer either is a commercial choice
the owner has not made. Neither is in MASTER_PRODUCT_SPEC.md.

**When revisited:** a coupon belongs in `placeOrder`, priced inside the
placing transaction with a per-customer usage row locked the same way capacity
is; the deposit is then a percentage of the discounted total, and a refund
returns what was paid, never the undiscounted price.

## D-032: An address an order used is never edited or deleted in place

**Decision:** Orders reference `addresses.id` and do not copy the address. So
editing a saved address that any order has used writes a new row and detaches
the old one from the account (`user_id` null); removing one detaches it. Only
an address no order has used is updated in place or deleted.

**Why:** Editing in place would silently change where a past order says it was
delivered, which is exactly the historical record staff and couriers rely on.
Snapshotting the address onto `orders` would also work but needs a data
migration of every existing order; copy-on-write needs none.

## D-031: The wishlist is account-only, and "save for later" is the wishlist

**Decision:** The wishlist uses the existing `wishlist_items` table (variant
plus user, no price). Guests are asked to sign in. "Save for later" in the cart
moves the line onto the same list, and "Move to cart" moves it back through the
cart's normal availability check. "Recently viewed" is a cookie of product ids
that the server resolves through the public predicate.

**Why:** One saved list is simpler than two that differ only by which screen
created them, and it keeps the cart a list of things to buy now. A guest
wishlist would need its own token and merge rules for little gain. The cookie
holds ids only, so tampering can at worst show nothing.

## D-030: Filters travel under the attribute's own name, and one name is one filter

**Decision:** Attribute filters use the attribute's name as the URL key
(`/search?q=shirt&size=m&color=black`). A key matches a variation attribute
*or* a category specification of the same name, so a shopper sees one
"Colour" filter whichever system the value lives in. An attribute whose name
collides with a reserved parameter travels as `attr-<name>`. Unknown keys are
dropped after checking they name a real attribute. Old `?value=<uuid>` links
still work.

**Why:** The brief asks for shareable, readable URLs, and ids are neither.
Two "Colour" filters because staff happened to model colour once as a
variation and once as a specification would be an implementation detail
leaking onto the page. Dropping unknown keys matters: a share-tracking
parameter read as a filter would open every shared link on an empty page.

**Cost:** a legacy `value=` filter still applies but gets no chip (its label
is no longer in the facets); "Clear all" removes it.

## D-029: Search analytics count people without knowing who they are

**Decision:** A search is logged with a daily-rotating, server-keyed hash of
connection and browser — no account id, no address. One row per visitor,
query and half hour. Searches shaped like an email or a phone number are never
stored. A query is shown to other shoppers (popular, trending, completions)
only once three distinct visitors ran it and it found something. Rows older
than 180 days are pruned by the scheduled sweep. A signed-in customer's own
recent searches are a separate table they can clear, removed on anonymisation.

**Why:** The brief asks for popular searches "only if there is enough real
data", and three people is the smallest number that is a trend rather than
one person's search shown to strangers. Conversion cannot be measured without
tying a search to an account, so it is reported as not measured rather than
approximated.

## D-028: Suggested products carry their price

**Decision:** Autocomplete product rows show the price a shopper would pay.
This supersedes the earlier rule "autosuggest never returns a price".

**Why:** The search brief asks for it by name, and the price is the same
public figure on every card and results page — the old rule protected
nothing a shopper could not already see 24 at a time. What stays excluded:
stock levels and anything sourcing-related, which the query cannot return.

## D-027: Relevance is a tier first, everything else second

**Decision:** Results are ordered by a relevance tier — exact code, exact
name, the brand, the phrase in the name, every word in the name, in the
strong fields (brand, model, keywords, shelf), in highlights and
specifications, anywhere — and only within a tier by the text fit, the staff
boost (−2 to 2), sales, rating, availability and recency.

**Why:** The brief's rule is that popularity must never overpower an exact
match, and neither should a staff nudge. A blended score can only promise
that by tuning weights; a tier makes it structural, and every reordering a
signal can cause stays inside a group of equally relevant products. Within the
name tiers, a name the search covers more of wins ("Apple iPhone 15" over
"iPhone 15 Silicone Case" for "iphone 15"), and a name ending with the search
is the thing rather than an accessory for it.

## D-026: Search stays in Postgres, as a trigger-maintained index table

**Decision:** No external search service. `product_search` holds one row per
product: a weighted tsvector (A name, B brand/model/codes/keywords/shelf,
C highlights/options/specifications, D description/spec table/tags) plus the
normalised name and codes the ranking compares. `product_search_words` holds
each listing's vocabulary with a pg_trgm index for typo correction.
Triggers on every source table queue a product; a deferred constraint trigger
rebuilds each queued product once, at commit. Visibility is never indexed —
every query joins `products` with the public predicate.

**Alternatives considered:** Meilisearch/Typesense/Algolia; keeping the single
expression index on `products` (D-018); maintaining the index from
application code.

**Why:** The catalogue is hundreds to low thousands of products, which Postgres
full-text and trigrams serve in milliseconds; a hosted service is a second
system to deploy, pay for and keep in step. The old expression index could not
see anything in another table — category names, option values, category
specifications — so those were unindexed subqueries. Application-side
reindexing depends on every current and future write path remembering to call
it; triggers cannot be forgotten. The deferred trigger means a product edited
fifty times in one transaction is rebuilt once, and the capacity columns a
checkout touches are not ones the triggers watch, so checkout pays nothing. A
rebuild that fails is logged, not raised — a broken index row is not a reason
to refuse a product save — and the product stays queued for the sweep.

**Typo tolerance** is correction, not fuzzy matching: a search is first run as
typed (with prefixes and stemming, which already catch "iphon", "airpod",
"headphons"); only if it finds nothing are the words that match nothing
replaced by the closest word in the vocabulary of public listings (trigram
similarity ≥ 0.35, same first letter), and the page says so with a link to
search exactly what was typed.

**Cost:** pg_trgm is required (available on Neon, embedded Postgres and PGlite).
Accented letters are not folded. Supersedes D-018.

## D-025: Category-defined specifications, stored as JSON on the product

**Decision:** A category may define the specifications its products are asked
for (`category_attributes`), and a product stores its answers in a single
`products.attribute_values` JSON object keyed by definition id. Definitions are
inherited down the category tree. This is a second, separate system from the
`attributes` tables that drive variation.

**Alternatives considered:** a hard-coded field per attribute on `products`; a
`product_attribute_values` join table; reusing the existing variation EAV for
specifications too.

**Why:** A column per attribute means a migration every time the shop takes on
a shelf, which is exactly what the brief rules out. A join table would be more
normal, but every read of a listing needs all of its specifications at once and
none of them is ever queried on individually, so the join buys nothing and
costs a query on the busiest page in the shop. Reusing the variation EAV was
rejected outright: adding a value there multiplies a product's SKUs, so
"Processor: M4" would generate a variant per processor. The two systems answer
different questions and must not share a table.

**Cost, and how it is contained:** a JSON object cannot be constrained by the
database. Every save is therefore validated on the server against the
definitions the product's category actually asks for
(`validateAttributeValues`), a value belonging to another category is refused
rather than stored, blanks are dropped rather than kept, and deleting a
definition removes the answers with it so nothing orphaned can ever render.

## D-024: A sale is a second price with a window, resolved in SQL

**Decision:** `product_variants` carries `sale_price_bdt`, `sale_starts_at` and
`sale_ends_at` beside `price_bdt`. Every query that reads a price — the cart,
order placement, the product page, the cards, sorting and the price facet —
resolves the sale through the one expression in `lib/catalog/price.ts`.

**Alternatives considered:** editing `price_bdt` when a sale starts and putting
the old value back afterwards; a separate `promotions` table; deciding whether
a sale is live in TypeScript at render time.

**Why:** Overwriting the price loses the number the discount is a saving
against, so the page cannot honestly show what a shopper is saving, and a
missed restore leaves the shop selling at the sale price forever. A promotions
table is the right shape for stacked, coded, cart-level offers, and none of
those exist — §9 of CLAUDE.md says to take the simplest option that extends
later, and a per-variant window does. Deciding in TypeScript would mean the
cart, the order and the page each consult their own clock; the database is the
one clock the whole system already shares, which is the same reason
`is_closed` is computed in SQL.

**Consequence:** the server is still the only thing that prices an order. The
client sends an identifier and a quantity, and the sale window is evaluated
inside the transaction that places the order — a sale that ended a second
earlier is not honoured.

## D-023: Lifestyle imagery is a kind of product image, not a second table

**Decision:** `product_images.kind` distinguishes `gallery` from `lifestyle`.
Each kind is ordered independently, and the product page uses them in different
places: the gallery in the buy box, the lifestyle set in a band below the
description.

**Alternatives considered:** a `product_lifestyle_images` table; a boolean
column; keeping them in one gallery and letting staff order around it.

**Why:** They are the same thing — a stored file, an alternative text, a
position — and every operation on them (upload, reorder, promote, remove,
delete the file behind the row) is identical. A second table would duplicate
all of it. One gallery was rejected because the first image is the main one
everywhere else on the site, and a lifestyle shot sorted to the front would
silently become the product card's photograph.

## D-022: The product editor is panels that each save only their own fields

**Decision:** `PATCH /api/admin/products/[productId]` applies a partial update:
a field that is absent keeps its stored value, and `null` clears it. The admin
product page is a set of panels, each posting only the fields it owns.

**Alternatives considered:** one long form posting the whole record; each panel
echoing the untouched fields back with its own.

**Why:** The arrangement this replaced did echo everything back, and that is a
trap — a panel that forgot one field silently erased it, and the code carried
comments pleading with the next author to remember. A listing now holds far
more than one screen of fields, so the form had to be split; making the API
partial is what makes splitting it safe. It also means the distinction between
"not sent" and "cleared" has to be explicit, which is why every clearable field
is `.nullable().optional()` and the forms send `null` rather than dropping a
key.

## D-021: The hero carries no words, and the row beneath it is curated

**Decision:** The hero is a photograph and nothing else — no headline, no
paragraph, no eyebrow, no price panel, no button. The four products directly
beneath it are chosen and ordered by staff at `/admin/homepage`, or added from
a product's own admin page, and stored as a list of slugs under
`home.showcase`. Staff choices lead the row and the catalogue fills whatever is
left, so the row is always four.

**Alternatives considered:** keeping an optional headline that staff could
clear; a `featured` boolean on the product row; padding a short curated row with
nothing.

**Why:** The owner asked for the image to be unobstructed — "remove that
american goods landed in bd, Preorder, and the rest blocking the big image" —
and an optional headline is a control that mostly wants to be empty, plus a
scrim over the photograph to keep it readable. Taking the words off entirely
also removes the scrim, which is why the picture now looks like a picture.

A boolean on the product cannot carry order, and order is most of what a
curated row is. It would also spread the homepage's composition across every
product row rather than keeping it in one place a person can read.

The row is padded from the catalogue rather than left short because a front page
with one card and three holes is worse than one where staff have expressed a
partial preference — and because that is what happens the moment somebody
removes a product from the row and does not immediately replace it.

**What it costs:** the first screen no longer states the landed-price promise.
That sentence now sits directly under the row, which is the first thing below
the photograph, and again at the foot of the page. The page's `h1` is
visually hidden — a page still needs one, and it should say what the shop is
rather than what today's first product is.

## D-020: The homepage hero is one image, chosen by staff, stored in `site_settings`

**Decision:** The rotating five-slide hero is gone. There is one hero image, and it is a single row in `site_settings` under the key `home.hero`, edited at `/admin/homepage`. (It carried words and a featured batch when this was written; D-021 took those off the image.) Writing needs a staff session; the storefront reads it with no session at all. The photograph goes through the existing media provider, so it lands wherever product photography lands.

**Alternatives considered:** a new `homepage_hero` table; hero fields on the product record; keeping the hero in source and letting a developer change it.

**Why:** A table for one row is a migration and a model for something that is configuration, and `site_settings` already carries the audit trail, the staff gate and the "corrupt row falls back to the default" behaviour that a front page needs. Putting the fields on a product would ask whoever uploads a photograph to answer a question about the *homepage* while editing a *product*, and it goes stale the moment the featured product changes. Leaving it in source fails the brief outright — the owner asked to change the hero without touching code.

Two details are deliberate. The `imageUrl` is never accepted as a posted string: it is set by uploading a file or cleared, so the front page cannot be pointed at an arbitrary address on the internet. And the call-to-action link is validated as an internal path, because a text field that becomes an `href` is how an open redirect gets built by accident.

**What it costs:** staff, not just a super admin, can change the front page of the shop. That is the same bar as uploading product photography, which is the comparison that matters — the audit log names who changed it, and nothing here can move money.

## D-019: A recommendation is scored, never random, and it falls back to popular

**Decision:** `lib/catalog/recommendations.ts` scores every public product against the one being viewed: a relationship staff stated in `product_related` counts 10, the same category 4, a shared tag 3, the same brand 2, a comparable price 1. Anything scoring zero is not a recommendation. When too few products score, the row is topped up with the best-rated products instead of being left short or filled at random.

**Alternatives considered:** behavioural recommendations from browsing or purchase history; the previous behaviour, which was "four other products in the same category".

**Why:** Behavioural recommendations need traffic this shop does not have yet, and they need view-tracking that the privacy posture in SECURITY.md would have to be re-argued for. Everything used here is already recorded and already curated by hand, which is the strength of a small catalogue: staff know that a kettle goes with a grinder, and `product_related` is where they say so. The fallback is explicitly *popular* rather than *random* because a shopper can see the sense in "this is what people rate highly" and cannot see any sense in an unrelated product.

## D-018: Search is Postgres full-text over the whole listing, with a GIN index the query must match

**Decision:** Searching matches the listing's own text — title, brand, description with its markup stripped, bullet points, spec table, tags and meta description — through `to_tsvector('english', …)`, plus the category name, the variants' attribute values, and the title as a plain substring. Every typed word becomes a prefix term (`key:*`) and terms are ANDed. Migration `0012_product_search.sql` adds a GIN index on exactly the same expression the query builds.

**Alternatives considered:** a hosted search service; `pg_trgm` similarity; keeping `title ILIKE '%term%'`.

**Why:** The old query found a product only for someone who already knew its name — the one shopper who does not need a search box. A hosted service is a second system to run, pay for and keep in step with the catalogue, for a catalogue that fits comfortably in Postgres. Trigrams handle typos well but rank badly across fields and need a separate extension. Full-text is already in the database, ranks with `ts_rank_cd`, and is fast behind the index.

Three things are worth knowing later. The document expression is duplicated in the migration and in `lib/catalog/search.ts`, with a comment on both sides, because Postgres only uses an expression index when the expression matches exactly — a mismatch does not break search, it silently makes it a sequential scan. Prefix terms are what make the same code serve the autocomplete while someone is still typing. And the substring match on the title is kept alongside full-text because a stemmed prefix query cannot find "board" inside "Keyboard", which shoppers try constantly.

## D-017: One rounded sans for the whole shop, replacing the serif display face

**Decision:** Fraunces and Inter are replaced by Figtree in five weights. Display and body are the same family; weight and tracking separate them. Radii grow from 4px/2px to 10px/14px/20px.

**Alternatives considered:** keeping Fraunces for headings and adding a rounded sans only on the homepage.

**Why:** The owner's brief for the redesign names a modern rounded sans as the reference and rules out a serif display face by name. Applying it only to the homepage would give the shop two identities a click apart, which is worse than either identity on its own. One variable family also takes a font file off the critical path of a first screen that is now dominated by a photograph.

**What it costs:** the editorial character the serif carried is gone, and the shop reads as a modern catalogue rather than a printed manifest. That was the trade the brief asked for, and it is reversible in one file — `app/layout.tsx` loads the family and `app/globals.css` maps it to `--font-display` and `--font-sans`.

## D-016: The header's treatment over a hero is measured in the browser, with a manual override

**Decision:** The floating header picks navy or pale lettering from the average relative luminance of the current hero image, computed client-side by drawing the image into a 32×32 canvas (`lib/hero-tone.ts`). A per-slug map, `HERO_TONE_OVERRIDES`, overrides the measurement where it is wrong. The first server render assumes a light background, and a correction after measurement crossfades over 500ms rather than snapping.

**Why:** The alternatives were each worse in a specific way. Storing a tone on the product record would make whoever uploads a photograph answer a question about the *home page* while editing a *product*, and it would go stale the moment the photograph is replaced. Computing it on the server would mean rasterising SVG and decoding images inside a request, for a decision that changes nothing anyone can act on. A fixed dark scrim over the whole photograph would make the header readable by making every hero image darker, which is the one thing the brief ruled out. Measuring in the browser costs a 32×32 `getImageData` per slide, once, and degrades to a readable default whenever the pixels cannot be read — a tainted canvas throws, and the header simply keeps the treatment it had. The override exists because an average is wrong in a predictable case: an image that is mostly dark with a bright sky exactly where the navigation sits.

## D-015: Refunds are recorded, not charged

**Decision:** The refund control records a refund that staff have already paid by hand. It does not call the payment gateway. Staff enter the amount, the reason, and the reference of the transfer they made; the system writes a refund payment row against the charge it reverses. The product owner set this: "refund will be done manually as per our terms and that will be set later but refund will be manual."

**Alternatives considered:** calling `provider.refund` so the gateway returns the money automatically, which is what the code did until now.

**Why:** The refund terms themselves are not written yet, and an automatic refund makes a decision the business has not made. Paying by hand also matches how the money actually moves for a shop this size — bKash and bank transfers reconciled by a person — and it removes a failure mode that is genuinely nasty: a gateway call that fails halfway leaves a customer's money somewhere this system cannot see.

The system's job is therefore bookkeeping, and it does that strictly. A refund is always a payment row, never a silent adjustment to a figure on the order (docs/SECURITY.md), and each row points at the charge it reverses so a second part-refund can tell how much of that charge is left.

`provider.refund` stays in the payment interface. When a real gateway arrives it may be worth automating, and the interface should not have to be re-invented to do it.

**What it costs:** nothing stops staff recording a refund they did not actually pay. That is a bookkeeping risk rather than a technical one, and the audit row naming who recorded it is the control.

---

## D-014: A shopper's cancellation is a request; staff make the decision

**Decision:** The customer's control asks us to cancel. It records a request and changes nothing else: the order keeps its status, keeps moving, and keeps its capacity. Requests appear in their own category in the admin order pipeline, with the customer's reason in their own words, and staff approve or decline from the order page. Approving runs the ordinary cancellation, which is what returns the places. The product owner set this: "I will do the final cancel after the client cancels ... we will recheck the thing, client feedback and then cancel from the admin site."

**Alternatives considered:** what this used to do — the shopper cancelling outright while the order had not been sourced, with capacity returned immediately.

**Why:** This is a business that buys goods abroad in batches. Whether a cancellation is straightforward depends on where the batch has got to, on what the customer actually wants, and on terms the owner has not written yet. A button that made that decision on its own would be making it wrongly some of the time and irreversibly every time.

Three consequences, all deliberate:

**Capacity is held until the decision.** It used to come back the moment the shopper pressed the button. Releasing it early would sell their place to somebody else while they were still waiting to hear from us, which is the opposite of what a request means.

**Requests are allowed after sourcing.** The old rule refused a shopper outright once the item had been bought. That is exactly the case where somebody needs to talk to us, so a request is allowed at any stage before delivered, cancelled or refunded, and staff decline the ones that cannot be honoured.

**Asking twice is not an error.** A second request returns the first one rather than failing, because somebody pressing again is somebody wondering whether it registered.

The customer is only told their order is cancelled when it actually is — on approval, through the same message as any other cancellation. Nothing is sent when the request is filed, because "we have your request" is a promise the outbox cannot yet keep with no email provider connected; the order page shows the request instead.

---

## D-013: Customer records are kept indefinitely; nothing is deleted on age

**Decision:** There is no retention period and no scheduled sweep. A customer's name, address and contact details stay until somebody asks for them to be removed. The product owner decided this directly: "information will always stay."

**Alternatives considered:** anonymising personal fields automatically once an order passed some age — a few years, matching whatever Bangladeshi tax law requires records to be kept for.

**Why:** SECURITY.md carried "the data retention period under Bangladeshi law" as an open question, because a sweep needs an age to sweep at and guessing that number wrong is the kind of mistake that matters in both directions — deleting something the tax authority wanted, or keeping something a person was entitled to have removed. The owner's answer removes the question rather than answering it: nothing expires, so no age is needed.

**What this does not change.** `anonymiseCustomer` stays exactly as it is. It exists for a customer who asks to be forgotten, and a shop with no way to comply with such a request has a legal exposure rather than a retention policy. The decision here is about *automatic* deletion, not about refusing a request.

**What it costs.** The longer personal data is held, the more there is to lose in a breach. That is a real trade and the owner has made it knowingly. It raises the value of the controls already in place — the session hashing, the argon2id passwords, the role gates, the audit log — and it means an encrypted-at-rest database matters more than it otherwise would when this is deployed for real.

If a retention period is ever set, the sweep is small: `anonymiseCustomer` already does the work, and a scheduled job would only have to choose which accounts to call it for. The maintenance route at `/api/cron/maintenance` is where it would go.

---

## D-012: The balance on a deposit order is taken by staff, not charged automatically

**Decision:** When an order was placed with a deposit, the remaining balance is collected when a member of staff presses a button on the admin order page. It is not charged automatically on any event — not when the window closes, not when the goods are sourced, not when they land. The amount is computed on the server from the order's own payment rows; the request carries no figure. The customer is told by email once it is taken, and sees what is outstanding on their order page in the meantime.

**Alternatives considered:** charging the balance automatically at a fixed point in the pipeline, most plausibly when the order reaches `shipped_from_us`.

**Why:** DATABASE.md recorded this as an open question and the product owner answered it directly: staff-triggered. That is also the safer default. An automatic charge fires on a schedule nobody is watching, against a card or wallet the customer authorised weeks earlier for a smaller amount, and the first a person hears of it is their bank. A batch that goes wrong — a supplier shortfall, a price change, a customer who has asked to cancel — becomes a set of charges to unwind rather than charges never made. Staff pressing a button is one person deciding one order is ready to settle, which is what the money actually depends on.

The cost is that a balance can be forgotten. That is visible rather than silent: the admin order page states what is outstanding, and the figure is computed from payments rather than from `amount_due_now_bdt`, which records what was asked for at placement and would otherwise drift as refunds and captures accumulate.

Idempotency has three layers, because a duplicate here costs a real person real money: a captured balance row short-circuits before the provider is called, an *initiated* row is resumed rather than replaced, and the provider is handed a key derived from the order id.

If the business later wants this automatic, the same function is what a scheduler would call; only the trigger changes.

---

## D-011: The waitlist is notified when places open, and no place is held

**Decision:** When capacity is returned to a full preorder variant — an order cancelled, or staff raising the ceiling — everyone at the front of that variant's waitlist is sent a message saying places are available, oldest entry first, up to the number of places that actually opened. No place is reserved for them: the first person to order takes it. Each entry is marked `notified_at` so nobody is told twice, and the message says plainly that nothing is being held.

**Alternatives considered:** reserving the freed place for the next person in the queue for some window — a few hours, say — before releasing it to everyone.

**Why:** DATABASE.md recorded this as an open question, automatic re-offer versus manual, and the product owner asked for the work to continue rather than wait on the answer. So this is the simplest option that is defensible and cheap to change. A held place is a second kind of reservation: it needs its own expiry, its own scheduler to release it, its own display on the storefront ("held for someone else"), and its own interaction with the transaction that prevents overselling. MASTER_PRODUCT_SPEC.md does not ask for any of that, and CLAUDE.md §9 says to pick the simplest option that is secure and correct rather than invent complex behaviour.

Nothing about this forecloses the other choice. The queue order is recorded, `notified_at` distinguishes told from untold, and adding a hold later means adding an expiry to the waitlist row — no data is lost or reinterpreted in the meantime.

The honesty of the message is part of the decision. "A place is available" reads as "a place is yours" unless it says otherwise, and someone who drops what they are doing only to find the batch full again is worse served than someone who was never written to. So the message states that the place is not held.

---

## D-010: The landed price is split for the books, never added to at checkout

**Decision:** A variant's price is the landed price — goods, freight and customs duty already inside it. At order placement that price is decomposed into `subtotal_bdt` (goods), `shipping_fee_bdt` and `duty_bdt`, which always add back to exactly `total_bdt`. The rates live in `site_settings` (`landed.shipping_per_kg_bdt`, `landed.duty_percent`, `landed.assumed_weight_grams`).

**Alternatives considered:** the conventional model — goods at the top, freight and duty added as lines at checkout. It is simpler, it is what every other importer does, and it is exactly the surprise this shop exists to avoid (MASTER_PRODUCT_SPEC.md §5). The other alternative was leaving `shipping_fee_bdt` permanently zero, which is what the code did before: honest, but it left the business unable to see what a sale was made of.

**Why:** The promise to a shopper is one fixed number with nothing to pay at the door. Adding lines at checkout would break that promise even if the arithmetic matched. Deriving the split from the price keeps the promise exactly and still gives the shop a real freight and duty figure per order. Because the price is the input, changing the duty percentage cannot change what anyone is charged — a test asserts that directly.

**Cost:** The split is an estimate, not a customs declaration. Freight is priced by weight from a single rate, and duty by one percentage rather than by HS code. When real invoices arrive, the rates get better; the decomposition does not have to change.

## D-009: Notifications go through a transactional outbox, not a direct send

**Decision:** An order event writes a row to `notifications` inside the same transaction as the change that caused it. Delivery is a separate step (`deliverQueuedNotifications`) that reads queued rows and calls the provider. Each row carries a `dedupe_key` of `order:<order id>:<status>` under a unique constraint.

**Alternatives considered:** calling the email provider directly from `advanceOrder` and friends, which is simpler and was the obvious first move.

**Why:** A direct send sits inside the transaction or just outside it, and both are wrong in a way a customer notices. Inside, a slow or failing provider holds a row lock on an order — and on the preorder capacity it touches. Outside, a crash between commit and send loses the message with no record that it was owed. The outbox makes the message part of the same commit as the fact it describes, and leaves a queued row to retry when delivery fails. The dedupe key is what makes a replayed payment webhook stop at the database rather than at a customer's inbox, which is the idempotency rule in CLAUDE.md section 7 applied to messages rather than to money.

**Cost:** a message is not delivered by the act of queueing it. Something has to drain the outbox — today the request that queued it does so in the background, and staff can drain it by hand from `/admin/notifications`. A scheduled drain is the obvious next step once there is a real provider.

## D-008: PGlite used to verify migrations and seed data in tests

**Decision:** `tests/schema.test.ts` and `tests/seed.test.ts` apply the checked-in migration to PGlite (Postgres compiled to WASM, running in-process) and run the real seed against it.

**Why:** This machine has no PostgreSQL server, no Docker, and no psql, so `npm run db:migrate` cannot be run here. The alternative was to mark the migration unverified and hope it applies. PGlite is real Postgres, so the migration, every check constraint, and the seed are genuinely exercised on every `npm test` — including the capacity ceiling constraint, which is the schema-level half of the no-overselling rule. It is a test dependency only; development and production still use a real Postgres server through postgres-js.

## D-007: `paper` and `paper-raised` aliased to white and blue-50

**Decision:** `app/globals.css` defines `--color-paper: #ffffff` and `--color-paper-raised: #f2f7ff`.

**Why:** DESIGN_GUIDELINES.md refers to `paper` and `paper-raised` in its accessibility floor and in two signature-pattern descriptions, but its color table defines neither — the table names `white` and `blue-50` instead. Rather than leave the tokens undefined and let each component invent its own, they're aliased to the two values the surrounding prose clearly intends. This is a reading of an inconsistency in the guidelines, not a design decision, and should be confirmed with whoever owns the design system; if the intended `paper` is an off-white rather than pure white, only these two token values change and nothing else in the codebase does.

## D-006: Attribute system uses EAV (entity-attribute-value), not fixed columns

**Decision:** Product variation is modeled as `attributes` / `attribute_values` / `variant_option_values`, not as fixed `size` and `color` columns on the variant table.

**Why:** MASTER_PRODUCT_SPEC.md §2 requires admins to define arbitrary attribute types (color, size, material, storage, edition, bundle, compatibility, ...) and generate combinations from them. Fixed columns cannot express an admin-defined attribute set. EAV costs query complexity (variant lookup by attribute needs joins) but that cost is paid once in `lib/catalog/` and is worth it against the alternative of a schema migration every time a new attribute type appears.

## D-005: Preorder capacity lives on the variant, not a separate cross-product batch entity

**Decision:** `preorder_capacity`, `preorder_reserved`, and `preorder_closes_at` are columns on `product_variants`. There is no shared "sourcing batch" entity spanning multiple products.

**Why:** MASTER_PRODUCT_SPEC.md §3 describes preorder as slots/capacity per listing, not a cross-product run. An earlier draft of this spec (superseded) modeled a shared batch entity; the current spec doesn't call for it, and inventing one would be exactly the kind of complexity §9 warns against. If a future requirement needs to group variants into a shared US purchase run, add a `sourcing_runs` table then, against a real need.

## D-004: Payments and shipping go behind a provider interface with a mock implementation

**Decision:** `lib/providers/payment` and `lib/providers/shipping` define an interface; a mock implementation satisfies it until SSLCommerz and a courier/tracking integration have real credentials.

**Why:** MASTER_PRODUCT_SPEC.md §6 and §7 require this explicitly, so the app is runnable and testable end to end before external accounts exist. SSLCommerz is the assumed primary gateway (aggregates card, bKash, Nagad, Rocket) because it's the standard Bangladesh payment aggregator; if the business instead integrates bKash/Nagad directly, only the provider implementation changes, not the call sites.

## D-003: PostgreSQL with Drizzle ORM, not Prisma

**Decision:** PostgreSQL, accessed through Drizzle with checked-in SQL migrations.

**Why:** The preorder capacity check (§7: "no overselling / no over-preordering") is the highest-risk piece of correctness in this system, and it must run as a `SELECT ... FOR UPDATE` or equivalent inside an explicit transaction. Drizzle stays close to SQL and makes that transaction visible and reviewable in the query itself. Postgres gives real transactions and constraints, which a capacity engine and a financial audit log both need.

## D-002: Session-based auth with a hand-rolled sessions table, not an auth-as-a-service library

**Decision:** Password hashing (argon2id) plus a `sessions` table referenced by a signed HTTP-only cookie. No NextAuth/Auth.js, no third-party auth provider.

**Why:** There are exactly three roles (`super_admin`, `staff_admin`, `customer`) with server-enforced, per-route authorization (§7), and admin actions must write to an audit log tied to the acting session. A general-purpose auth library adds an abstraction layer between the session and that authorization logic for no benefit at this scale. Revisit if social login or SSO becomes a real requirement.

## D-001: Next.js (App Router) with TypeScript, Tailwind, Vercel + Neon Postgres

**Decision:** Next.js App Router, TypeScript strict mode, Tailwind CSS driven by the DESIGN_GUIDELINES.md token set, deployed to Vercel with Neon for serverless Postgres, Cloudflare R2 for product imagery.

**Why:** MASTER_PRODUCT_SPEC.md §6 requires SEO (metadata, structured data, sitemap) and a fast mobile-first storefront, which favors server-rendered pages over a client-only SPA. The same app serves the customer storefront and the internal admin dashboard, which keeps deployment and auth code in one place. Neon's branching model gives each phase of work an isolated database without standing up separate Postgres instances by hand. Cloudflare R2 is chosen over storing images in Postgres or in the app's own filesystem because Vercel's serverless runtime has no persistent disk, and R2's egress pricing suits an image-heavy storefront.

## D-041 — Product photography is stored in Vercel Blob on a deployment

**Context:** D-001 chose an object store for media and named Cloudflare R2, and
until now only the local provider existed: it writes into `.uploads/` and a
route handler serves the bytes. A serverless deployment has no persistent
disk, so an upload there either fails outright or is lost on the next request.
The shop is deployed on Vercel, which offers a first-party object store with no
credentials to manage.

**Decision:** `BlobMediaProvider` stores uploads in Vercel Blob, in a public
store, under a generated key. `MEDIA_PROVIDER` selects the implementation; with
nothing set, a runtime holding `BLOB_READ_WRITE_TOKEN` uses Blob and everything
else writes to disk, so development keeps working untouched and a deployment
cannot silently pick the implementation that cannot work there.

The store is public because a product photograph is public — the storefront
shows it to every visitor. The key is an unguessable identifier, so nothing is
discoverable by trying URLs, and no private record is placed in it.

The URL stored on the image row is absolute and points at the blob host rather
than at this site, so `next.config.ts` names that host twice: in
`Content-Security-Policy: img-src`, and in the image loader's remote patterns.
Rows written before this change keep their `/uploads/...` path and are still
served by the local route.

**Alternatives considered:** proxying the bytes back through `/uploads/[key]`
would have kept every stored URL same-origin and left the policy alone, at the
cost of a second hop on every image and a provider interface that has to read
as well as write. Cloudflare R2 remains the option if this ever leaves Vercel;
the provider interface is unchanged, so that is one new file.

## D-042 — Signing in happens over the page, and Google is one of the ways

**Context:** Signing in meant leaving for `/login`, and coming back only if a
`next` parameter had been carried along. A shopper halfway down a product page
who wanted a wishlist lost the page they were reading. The only credential the
shop accepted was a password of its own, which every new customer had to invent
before they could buy anything. D-000 chose to own sessions and roles rather
than adopt an auth library, and noted that social login would be the reason to
revisit that.

**Decision:** Two additions, neither replacing what exists.

1. A sign-in dialog over the current page, with Sign in and Create account as
   two tabs, posting to the same `/api/auth/login` and `/api/auth/register`
   endpoints the pages already use. `/login` and `/register` stay exactly as
   they are and still serve every server-side redirect, every `next` link and
   every visit without JavaScript. The dialog is a native `<dialog>`, so focus
   handling, inertness and Escape come from the browser.

2. "Continue with Google", on the dialog and on both pages, as the
   authorization-code flow with PKCE written directly against Google's
   endpoints. No auth library: the session table, the role check and the second
   factor are already this app's own, and a framework would want to own all
   three.

The link is made on Google's subject identifier, held in a new
`oauth_accounts` table, never on the email address alone — an address can be
reassigned by the owner of a workspace domain, a subject cannot. An address
Google reports as *verified* may be matched to an existing account, which is
what lets someone who registered with a password later press the Google button
and arrive at the same account. An unverified address is refused outright.

An account created this way has no password at all, rather than a random one
nobody knows: `users.password_hash` becomes nullable, and the password path
refuses a null hash with the same message and the same cost as a wrong
password, so the response never reveals how someone else signs in.

Google does not stand in for the second factor. An account with TOTP gets the
same pending session it gets after a password, and is sent to `/login` owing a
code.

**Why it is off by default:** `googleConfig()` returns null unless both
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. The button is then not
rendered and both routes answer 404, so a deployment without credentials is
exactly the site it was before.

**Alternatives considered:** Auth.js would have brought Google and a dozen
other providers for a day's work, and then owned the session, which is the
thing this app most needs to keep — sessions are re-read on every request so a
revoked session or a changed role takes effect immediately, and admin actions
are audited against them. Google One Tap was left out: it signs people in
before they have decided to, which is the opposite of what the dialog is for.

**Assumption to overturn later:** the ID token's signature is not verified
locally. It is read only from the body of a direct server-to-server TLS
response from Google's token endpoint, which OpenID Connect Core §3.1.3.7
allows; issuer, audience and expiry are still checked. If the flow ever changes
so that a token arrives by way of the browser, the signature must be verified
against Google's JWKS first.

## D-043 — The chosen variant is the thing being sold, all the way to the order

**Context:** A shopper could pick "Pearl White · 3-Seater" and never see it
again. The cart joined the option values with a slash, the checkout summary
repeated that one string, and `order_items` never wrote `option_summary_snapshot`
at all — so every order screen, for staff and for the customer, read as a bare
product name. Separately the product page stacked Description, Key features and
a Specifications table down the page with no home for measurements, and there
was no way to buy without going through the cart.

**Decision:**

1. **One loader for what a variant is.** `lib/catalog/variant-options.ts`
   returns the option pairs (`Colour: Pearl White`) for a set of variants and
   formats the summary. The cart, the checkout summary and the order snapshot
   all use it, so the three cannot describe the same variant differently. A
   product with no options returns an empty list and its lines read as the
   product name alone, rather than the old "Standard".

2. **The order snapshots the variant.** `order_items` already froze the title,
   the price and the fulfilment mode; it now also freezes the option pairs, the
   option summary, the SKU and the variant's photograph. Nothing about a line
   is re-read from the live catalogue, so renaming an option or archiving a
   variant cannot rewrite what an order says. Orders placed before this change
   carry none of it and are shown as they always were — historical variants are
   never guessed at.

3. **Description · Specification · Measurements.** One tabbed panel on the
   product page. Measurements is a new `products.measurements` column
   (label/value rows staff type) plus the measurable fields of the advanced
   block; the specification table keeps everything else, so neither repeats the
   other. The tab is absent when the listing records no measurements.

4. **Buy now beside Add to cart.** It adds the line and goes straight to
   checkout — the same server-priced path, not a second one. With more than one
   option nothing is preselected: the panel prices the cheapest option as
   "From", and pressing either button without choosing asks for a choice. A
   product with exactly one option still starts selected, because there is no
   choice to make.

5. **SEO Pulse writes fuller descriptions and no invented facts.** The
   description now opens with what the product is, what it is made of and what
   it is for, then key features and what is in the box, then how buying works
   here — each section only when the listing supports it, so length follows the
   product rather than a word count. The specification and measurement tables
   are **derived** in `lib/seo-pulse/facts.ts` from the product's own recorded
   facts and are not part of the generated schema at all, so no model is even
   asked for a dimension, a material or a weight. The AI prompt states the same
   rule for prose. Where a fact is missing it is listed under "Needs your
   input" instead of being filled in.

6. **One account.** `/account` is the dashboard (live counts from the
   shopper's own orders, recent orders with the photograph and the version
   bought) and `/account/orders` is the full list — a route the header menu had
   been linking to while it did not exist.

**Why the tables are derived rather than generated:** a generated
specification is indistinguishable from an invented one once it is in the
database. Deriving them means the worst case is an empty table, which is
honest, instead of a plausible weight nobody measured.

**Alternatives considered:** letting the model propose specification rows and
filtering them against known facts afterwards would allow slightly richer
tables, at the cost of a filter that has to be right every time. Storing
measurements as fixed columns (length, width, height, weight) was rejected
because it fits furniture and not coffee beans; label/value rows fit both and
add one column instead of six.

## D-044 — The responsive pass keeps one layout, not a phone layout and a desktop one

**Context.** The shop was designed on a desktop and had already grown a fair
amount of responsive behaviour: a two-across product grid on a phone, a filter
drawer, a full-screen search overlay, a category drawer, a sticky buy bar and a
hero measured in `svh`. A full audit at every width from 320px to 1920px, in
portrait and landscape, found a small number of real defects rather than a
missing mobile experience.

**Decision.** Fix the defects inside the existing components and breakpoints.
No separate mobile components, no new breakpoint tiers, no bottom navigation
bar, and no change to any business rule.

1. **Two across on a phone, everywhere a product appears.** The "Windows
   closing soon" rail was the last one-across grid on the site; eight cards
   half a screen tall each put four thousand pixels between the hero and the
   rest of the homepage. It now uses the same progression as every listing —
   two on a phone, three on a tablet, four on a laptop — with the card's own
   type stepped down to match the catalogue card.

2. **Photographs are delivered at the size the screen needs.** A new
   `components/media-image.tsx` renders product photography through
   `next/image`, with a `sizes` string per call site, on the hero, the showcase
   tiles, the catalogue card, the closing rail, the category board and the
   product gallery and its thumbnails. SVG keeps the plain `<img>` element: the
   optimiser refuses SVG unless `dangerouslyAllowSVG` is turned on, and a
   vector has nothing to gain from resizing anyway.

3. **Modern viewport units and safe areas on anything anchored to the bottom
   of the screen.** The filter sheet is measured in `dvh` rather than `vh`, and
   both it and the product page's buy bar keep clear of `env(safe-area-inset-
   bottom)` so a phone's home indicator cannot sit on top of a control.

4. **A 16px floor on form controls, for touch screens under 1024px only.** iOS
   zooms the page in when a control smaller than that takes focus and does not
   zoom back out. The admin's 13px density is kept on a desktop, where the
   pointer is a cursor.

5. **No bottom navigation.** Search, wishlist, cart and the catalogue are all
   in the header, which is sticky, and the bottom of the screen on a product
   page already belongs to the buy bar. A second bar would duplicate the header
   and compete with it.

**Not done, deliberately.** The admin's dense tables still scroll sideways
inside their own container on a phone rather than becoming stacked cards. They
do not push the page sideways and every column stays reachable; converting nine
admin tables into a second card presentation is a larger piece of work than the
customer-facing defects it would be traded against.
