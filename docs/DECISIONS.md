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

## D-045 — On a phone the hero keeps the desktop composition

**Context.** D-044 gave the phone its own hero: a portrait photograph most of a
screen tall, and the showcase as a sideways-swiping row of large tiles. The
owner reviewed it on a phone and asked for it to look like the web instead.

**Decision.** One composition at every width — a landscape photograph with the
tiles across its foot — scaled to the screen. Below `md` the header becomes the
plain bar above the hero rather than floating over it, because a two-row header
over a 16:9 photograph that is 219px tall would hide half the picture. The
header's colour palettes are now classes rather than inline variables, which is
what lets a breakpoint pick the bar on a phone and the floating treatment from
`md` up.

**Trade-off accepted.** Tile titles on a 390px phone are 10px and truncate
sooner than on a desktop; that is the cost of four tiles in one row, which is
what the owner asked for. The swipe carousel from D-044 is gone.

**Amended after the next QC.** The owner asked for the header to be
transparent over the phone hero, as on the web, and for search to be an icon
with a pop-up. With search behind an icon the header fits on one row at any
width, so the plain bar below `md` was dropped: the header floats over the
landscape hero everywhere. The landscape composition itself stays.

## D-046 — The phone's shopping screens behave like an app, not a shrunk page

**Context.** The owner asked for a full mobile pass over the customer-facing
shop: a swipe gallery with no arrow buttons, compact cart rows, a total and
Checkout within reach, shorter descriptions, sideways recommendation shelves
and a footer that does not take a screen of links. The desktop was to stay as
it is.

**Decision.**
- **Gallery.** Every photograph sits in one horizontal scroll-snap track. Below
  `lg` the track is swiped with the browser's own momentum and a row of dots
  (real buttons, 24px targets) shows the position; there are no arrow buttons
  on a phone, in the page or in the full-screen viewer. From `lg` the same
  track is locked and driven by the thumbnails, jumping and fading the shot in,
  so the desktop looks as before. The frame is square but capped at 62svh, so
  a short or sideways phone still shows the title and price.
- **Buy box order.** Below `lg` the price, availability and batch meter come
  before the option chips, straight under the title. The desktop keeps options
  first. The sticky buy bar stays the phone's one place to buy (D-043).
- **Description.** Below `lg` a long description folds at about a dozen lines
  behind "Read more"; a short one shows no button.
- **Cart.** Rows are compact below `sm` (photo and name side by side, stepper,
  Remove and line total on one line). Below `lg` a bar with the amount due and
  Checkout rides the foot of the screen while the summary is still below the
  screen, and hides once the summary's own button is visible, so two Checkout
  buttons are never on screen together.
- **Recommendations** are a sideways shelf below `sm` and the grid from `sm`.
- **Footer** lists fold behind their headings below `md`.
- **Safe areas.** The root viewport is `viewport-fit=cover`. Without it every
  `env(safe-area-inset-*)` already in the stylesheet read zero.

**Not changed, deliberately.** The home hero and showcase keep the owner's
D-045 composition — a landscape frame with the tiles across its foot, not a
carousel — although the brief mentioned horizontal scrolling for the
showcase; the owner had already rejected that on a phone. The wishlist stays
per option (D-031), so the product page's heart button appears once an option
is chosen.

**Trap recorded.** A horizontal scroller must be positioned. The product cards'
`sr-only` text is absolutely positioned; inside an unpositioned `overflow-x:
auto` rail it escaped the clip, and a real phone widened the whole layout to
about 507px and zoomed out. Chromium's plain viewport emulation does not show
it — only `isMobile` does.

## D-047 — The phone's product page and cart follow the owner's reference

**Context.** After D-046 the owner showed the reference they had in mind: a
shopping-app product screen (a photograph edge to edge with back, share and
save over it, a short name-and-price row, and a bar with an option picker and
Add to cart) and a cart of slim rows with a subtotal and Checkout fixed to the
foot of the screen.

**Decision.** Below `lg`, and only there:
- **Product photograph** runs edge to edge with no card border. Back, Share and
  a heart sit on it in round buttons. Position marks are short dashes on the
  photograph. The breadcrumb is not shown (Back does its job; the structured
  breadcrumb data stays).
- **Heading.** A status pill, the name with its price beside it (following the
  chosen option, "From" until one is chosen), and two lines from the first key
  feature or the description. The buy box underneath loses its card surface.
- **Buy bar.** An option button and Add to cart. The option button opens a
  bottom sheet of every option with its price or "Full". Pressing Add to cart
  with nothing chosen opens the same sheet, and choosing there adds straight
  away. After adding, the button says "Added" for two seconds.
- **Heart.** Saves the chosen option (D-031 still holds — the wishlist is per
  option). With no option chosen it says so and opens the option sheet.
- **Cart rows** are slips on a pale ground: photograph, name, stock and deposit
  line, the option opposite the name, and the line total with a small stepper
  along the foot. At a quantity of one the minus is a bin. A row also slides
  left to show a bin.
- **Checkout bar** is fixed to the foot of the screen for the whole visit; the
  summary panel keeps the breakdown and its own button is desktop-only.
- **Room for bars.** A page with a fixed bottom bar sets `data-bottom-bar` on
  `<html>`, which pads the body so the footer is never under the bar.

**Overrides.** D-043's "Buy now" on the phone bar is gone — the reference has
one buy action. Buy now stays on a desktop. D-046's cart bar that appeared
only while the summary was out of view is replaced by the always-present one.

**Kept to Manifest's identity, not copied.** The brass call to action, the
brand type, and the preorder terms (deposit, arrival window, countdown, places
left) all stay on the page; the reference's black pill buttons and bare
fashion layout were not copied.

## D-048 — On a phone's product page the header waits until the photograph is scrolled

**Context.** With the photograph edge to edge and its own Back, Share and heart
buttons (D-047), the owner asked for the site header to be invisible while the
photograph is at the top, and to appear with an animation on scrolling down.

**Decision.** Below `lg`, on `/products/*` only, the header is fixed rather
than sticky, so the photograph starts at the top of the screen. It is moved up
by its own height and faded out while the photograph is mostly on screen, and
slides down (500ms, the site's ease-out) once about two fifths of the
photograph has scrolled off the top. Scrolling back up tucks it away again.

- It is moved and faded, never `visibility: hidden` or `inert`, so a screen
  reader still reaches the navigation; keyboard focus inside it brings it back.
- While it is showing it carries no translate at all. A transform on the header
  would become the containing block for the fixed category drawer and search
  inside it and squash them into the header's box.
- The gallery marks its frame `data-product-photo`; a product page without one
  (the loading state) shows the header.
- Reduced motion keeps the behaviour and drops the slide.
- Desktop and every other route are unchanged.

## D-049 — Product images are cropped in the browser before upload

**Context.** The owner asked for staff to upload any product image and frame
it in a crop editor — preset ratios with 4:5 as the default, a custom ratio,
drag, zoom, rotate, a preview — rather than preparing files beforehand.

**Decision.**
- **Where the crop happens.** In the admin's browser, on a canvas, before
  upload. The result (WebP, or JPEG where the browser cannot write WebP) goes
  through the existing `POST /api/admin/products/[id]/images` route, which
  keeps every check it had: staff only, the file's own bytes decide its type,
  5MB ceiling. No new dependency and no server-side image processing.
- **Geometry** lives in `lib/images/crop.ts`, pure and unit-tested; drawing,
  decoding and encoding in `lib/images/browser.ts`; the dialog in
  `app/admin/products/[productId]/crop-editor.tsx`.
- **Sizes.** The frame's long edge is 2000px, so 4:5 saves at 1600 × 2000. A
  crop that would enlarge the original is saved at the original's own
  resolution instead. Originals are decoded no larger than 6000px on the long
  side, and may be up to 40MB, so a camera file cannot freeze the page.
- **Product-safe first framing.** A photograph within about 12% of the frame's
  shape fills it; anything else is shown whole and the admin zooms in. Nothing
  is stretched — the picture is only scaled evenly.
- **Empty space** inside the frame is filled with the colour around the
  image's own edge (so a studio background stays that background), or white.
  No background removal or generation.
- **EXIF orientation** is applied when decoding (`imageOrientation:
  "from-image"`), and the saved file is written upright.
- **Several files** open one after another ("Image 2 of 5"); Cancel becomes
  Skip within a batch.
- **Edit and Replace** save through the same route with `replaceImageId`. The
  image keeps its id, position and (unless changed) description. The previous
  file is not deleted, because orders, carts and variants keep the address they
  recorded. Delete keeps its existing behaviour.
- **No schema change.** The ratio badge on each admin thumbnail is read from
  the image's real pixel size once it loads. Existing images are untouched and
  keep working.

**Not changed.** The storefront. Its catalogue cards and the desktop product
gallery are square frames that fill their box, so a 4:5 image shows there
with a little of its top and bottom trimmed (the editor's "Catalogue card"
preview shows exactly how much). Moving those frames to 4:5 is a
customer-facing change left for the owner to ask for.

**Amended (owner's QC).** The owner found no direct way to buy on a phone, so
Buy now is back on the phone's bar beside Add to cart, as on the desktop. The
option button is narrower (at most a third of the bar) so all three fit at
360px. Either buy button pressed with no option chosen opens the option sheet
("Choose an option to add" or "…to buy"); choosing there adds, and for Buy now
goes on to checkout.

## D-050 — The sign-in dialog is centred and animated, and Google is always offered

**Context.** The owner found the sign-in popup sitting at the top-left of the
screen and looking generic, and saw no way to sign up with Google. The corner
placement was a bug: Tailwind's reset removes the `margin: auto` a browser uses
to centre a modal `<dialog>`. The Google button was missing because D-042
hides it until credentials are configured, and none are.

**Decision.**
- The dialog gets `m-auto`, so it is centred, and a redesign: a round badge,
  a greeting and a one-line reason to sign in, a segmented Sign in / Create
  account control whose highlight slides between the two, and Google above the
  email form ("Continue with Google", or "Sign up with Google" on the create
  tab).
- Motion is CSS only, in `globals.css` under `.auth-dialog`: the backdrop fades
  and blurs, the panel rises with a slight spring, the badge pops in after it,
  switching tabs slides the form in, a refused sign-in shakes the error once,
  and closing sinks and fades. Clicking the backdrop closes it. The global
  reduced-motion rule turns all of it off.
- **The Google button is now always shown** — on the dialog, `/login` and
  `/register`. This overturns D-042's "off by default" for the button only;
  the flow itself still needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
  Without them, the dialog's button says "Google sign-in isn't switched on
  yet" in place, and `/api/auth/google/start` redirects to
  `/login?error=google-unavailable` instead of answering 404. The callback
  still answers 404 unconfigured, since nothing legitimate reaches it then.

**Assumption to overturn later:** a visible button that cannot yet work is
better than no button, because the owner is reviewing the site and wants to see
it. If the shop goes live without Google credentials, hide it again by
restoring the `isGoogleSignInEnabled()` checks.

## D-051 — Phone search is a small card; Browse by kind is a row of small tiles

**Context.** The owner found the phone search taking the whole screen and
asked for it to be small and usable like the desktop field, and asked for
"Browse by kind" to be more modern and take less room, with each category
no longer the size of a slide.

**Decision — search.** The header's search icon still focuses the hidden field
inside the same tap (so iOS raises the keyboard), but what opens is a card
fixed near the top of the screen, inset 12px from each side: the field, a close
button, and the same suggestions below it, capped at about 58% of the screen
height and scrolling inside. The page behind dims slightly and stays where it
is; tapping it, the close button or Escape closes the search. The full-screen
panel and its page scroll lock are gone. Desktop is unchanged.

**Decision — Browse by kind.** Every top shelf is the same compact tile: a
square photograph of something filed there, the name and a live count. No lead
tile. On a phone the tiles are one sideways row that settles on a tile, about
three to a screen; on a tablet five across; from `lg` a grid of tiles about
nine rem wide. The heading is smaller and the link reads "See all".

**Amended (owner's QC).** The small plain tiles were rejected as not modern
enough. Browse by kind is now an image-led board: on tablet and desktop the
first shelf is a tall feature card beside a two-by-two of the rest (about
400px high); on a phone, one sideways row of portrait cards, a little over two
to a screen. Each card shows its photograph whole, in a rounded frame with a
soft shadow, over a blurred, enlarged copy of the same photograph, so every
card wears its own colours and no photo is cropped or looks pasted on. A
frosted strip along the foot carries the name, a live count (and on the
feature card a few sub-shelves) and a round arrow. Two rejected attempts along
the way: multiplying the photo into a tinted ground (the seed art's own
backdrop still showed as a box) and a full-bleed cover (it cut products off
behind the label).

**Amended again (owner's QC).** The phone now uses the desktop board at phone
size rather than a sideways row: the first shelf as a tall feature card beside
a two-by-two of the rest, rows 7.5rem high (about 310px for the section). On a
phone the small cards carry only the name, which wraps to two lines in a
slightly smaller size; the feature card keeps its count and arrow.

## D-052 — An unpaid online order holds its places for 30 minutes

**Context.** Placing an order reserves preorder capacity (or stock) inside the
same transaction that writes the order, before any money moves. Until now no
code path ever gave those places back if the shopper never paid, so an
abandoned checkout kept a batch looking fuller than it was, indefinitely
(INITIAL_TECHNICAL_AUDIT.md, S3).

**Decision.** An order still `placed` with no captured payment is cancelled
automatically **30 minutes** after it was placed, and its reserved capacity is
released in the same transaction, with a status-history row and the usual
cancellation message. The window is the site setting
`orders.unpaid_hold_minutes` (default 30, allowed 5–1440), read in one place
(`lib/orders/expiry.ts`), not a number repeated around the code.

**What it does not touch.** Cash-on-delivery orders, which are paid at the
door and are never expected to have a captured payment at placement; any
order that has moved past `placed`; any order with a captured payment row.

**If a payment lands after the order expired.** The payment is still recorded
as captured, the order stays cancelled (its places may already belong to
someone else), and the order history says the payment arrived after expiry so
staff refund it. Reinstating the order automatically was rejected: it could
oversell a batch that has since filled.

**Why 30 minutes.** Long enough for a bKash/Nagad/card flow including an OTP
and a retry; short enough that a launch-day batch is not held hostage by
abandoned carts. The owner can change the setting without a deploy.

## D-053 — Background work runs from a Postgres job table, triggered on a schedule

**Context.** Expiring unpaid orders, delivering customer messages, reconciling
payments, rebuilding search rows and releasing SKU holds all have to happen
whether or not anyone is using the site. Until now they ran either inside a
shopper's request (fire-and-forget, which a serverless host may freeze) or in
one sweep a day, because Vercel's Hobby plan only allows a daily cron.

**Decision.** A `jobs` table is the queue. Work is enqueued inside the
transaction that causes it where that matters, claimed with
`FOR UPDATE SKIP LOCKED`, retried with exponential backoff, and moved to
`dead` after its attempt limit so a person can see it and retry it. Recurring
work is enqueued per time slot with a dedupe key, so two triggers in the same
minute schedule it once. `/api/cron/jobs` (bearer `CRON_SECRET`) schedules what
is due and runs jobs until it nears its time budget.

No new service: it is the database the application already depends on, and the
queue is visible to the same queries and backups as the orders it serves.
A managed queue (QStash, Inngest) was considered and left for later; the
handlers do not depend on how they are triggered.

**Assumption for the owner — how often it is triggered.** The expiry window is
30 minutes, so the trigger must run at least every few minutes in production.
Vercel Hobby cannot do that. Until the hosting plan is decided the daily
Vercel cron stays, and production needs one of: Vercel Pro cron every minute,
or any external scheduler (for example a GitHub Actions schedule or
cron-job.org) calling `/api/cron/jobs` with the secret every 1–5 minutes. This
is recorded as BLOCKED on hosting, not guessed.

## D-054 — Cache Components, adopted route by route; only shared catalogue data is cached

**Context.** Every storefront page was `force-dynamic` and re-read the
catalogue per request: one production process served 11–40 requests/second
on catalogue pages with 20 concurrent shoppers (INITIAL_TECHNICAL_AUDIT.md).
This version of Next.js replaces route-segment caching with Cache Components
(`use cache`, `cacheLife`, `cacheTag`), and `force-dynamic` is an error once
it is on.

**Decision.** `cacheComponents` is on. Every page and layout started with
`instant = false` (allowed to block), so nothing changed behaviour on the day
it was switched on; routes lose that line as they are converted. Only data
that is the same for every shopper and changes when staff change it is
cached: the category tree and counts, product cards and listings, product
detail, popular searches, the sitemap, homepage campaigns. Never cached:
sessions, carts, wishlists, recently viewed, checkout, and the live price,
capacity and closing time a shopper is about to act on — those stay
per-request and stream in `<Suspense>`.

Invalidation lives in `lib/cache.ts`: tags are named once, and the `lib/`
functions that change customer-visible catalogue data call
`invalidateCatalog` beside their audit write, so no route can forget.
Invalidation uses `expire: 0` — staff who publish expect to see it on their
next look.

**Found while switching it on.** A GET route handler that reads no request
data is prerendered at build under this model. The Google sign-in routes
returned "not configured" at build and would have kept saying so after
credentials were added; they now call `connection()`. Popular searches and
the sitemap read the database with no request data and would have frozen;
they are cached helpers with a lifetime and tags instead.

**Behaviour to know.** Client-side navigation now keeps recently visited
routes mounted (React `<Activity>`), so form state survives going back. The
full end-to-end suite passed with this on.

**Amended (Step B).** Invalidation runs after the transaction commits, not
from inside it: `db.transaction` queues work registered through
`runAfterCommit`, runs it once the commit succeeds and before the caller
returns, and drops it on rollback. Invalidating from inside the transaction let
a request that arrived before the commit re-cache the old rows.

One race remains and is accepted: a storefront request already computing a
cache entry from pre-commit rows can store its result after the invalidation.
That entry is then behind until its lifetime lapses — about a minute for
listings and product content. For that reason the homepage campaigns, which
staff check straight after saving, are read per request (one small row), and
nothing a shopper pays or reserves against is ever cached.

**Defect found on the way.** All five homepage slides live in one settings
row, and every edit read it, changed a slot and wrote every slot back. Five
simultaneous edits to five different slides kept one. Writes are now one
serialized read-change-write under an advisory lock
(`tests/homepage-concurrency.test.ts`).

**Amended (10.1 completion).**

- *Rendered output, not only data.* The category shelf, search results, the
  homepage's catalogue half and the product page's content sections are
  `use cache` components keyed by normalized public parameters (a slug, a
  sorted filter key). Each takes only strings, never a request, session or
  cookie. Measured on `manifest_scale`, one Node process, 20 concurrent
  clients, 100 and 200 requests, same machine: root category 41 → 51–53
  req/s, leaf category 50 → 56–64, search 50 → 57–61, homepage 64 → 67–72;
  product page 55 → 51–53 (no gain: its cost is the live buy box and HTML
  generation, not the cached sections); first byte unchanged at 15–50 ms p50.
  Serial render time stayed near 45 ms, because most of it is turning the
  payload into HTML, which a component cache does not skip. Kept because the
  gain on listings is repeatable and the change is small.
- *The layout no longer waits for the visitor.* Who is signed in and what is
  in their cart stream in behind Suspense boundaries in the header, with the
  guest header as the fallback. The root and storefront layouts no longer opt
  out of instant navigation; pages still do (`instant = false`), because
  each reads request data at its top level.
- *Invalidation gaps closed.* Option and option-value changes, photograph
  descriptions and photograph reordering changed what shoppers see without an
  audit entry, so nothing expired. They now record one
  (`tests/cache-invalidation.test.ts`).
- *Unknown category.* It renders the not-found page with `noindex` and a 200
  status, because the route streams behind its loading skeleton. Unchanged by
  this work.
- *Serverless.* Entries live in the default in-memory handler. On a
  long-running Node process every request shares them; on a serverless host
  each instance has its own, so hit rates there will be lower than measured
  here. `use cache: remote` (a platform-provided shared handler) would fix
  that at the cost of a network lookup. It is left for the hosting decision
  (D-053, Phase 21) rather than guessed at now.
- *The earlier 106 req/s root-category figure* (recorded when data caching
  landed) did not reproduce: the same build measured 41 req/s at the start of
  this work. The ledger carries the re-measured baseline.

## D-055 — Uploaded images are re-encoded on the server; files are deleted by a reference sweep

**Context.** The crop editor frames and compresses photographs in the browser
(D-049), but the server stored whatever bytes arrived once the signature
matched. A request that skipped the editor could store a 40-megapixel original,
a photograph carrying its GPS position in EXIF, a CMYK file that renders wrongly,
or an image with arbitrary bytes appended. Separately, removing a product
photograph deleted its file at once, although order lines record the address of
the photograph they were bought with — so the thumbnail on a past order went
blank.

**Decision.**

- Every upload through the media provider is decoded with sharp and written
  afresh (`lib/images/normalize.ts`). Decoding is refused above 40 megapixels,
  checked from the header before the bitmap is allocated. EXIF orientation is
  applied to the pixels; colour is converted to sRGB; no metadata is copied;
  the result is a single WebP (quality 85) no longer than 2,400px on its long
  edge, never enlarged. A file that cannot be decoded cleanly is refused.
- Responsive derivatives are not generated or stored. Every storefront
  photograph already renders through `next/image`, which produces the widths a
  device asks for from the stored master and caches them. Storing our own
  derivative set would duplicate that and require a custom loader.
- Every stored file is recorded in `media_objects` (key, provider, URL, bytes,
  dimensions, SHA-256). A recurring job (`media.sweep_unreferenced`, hourly)
  deletes a file once no product image, variant image, order line or site
  setting refers to it and it is more than 24 hours old. Each file is claimed
  by deleting its row with the reference check repeated in the same statement,
  so concurrent sweeps never double-delete and a newly referenced file is left
  alone; if storage refuses the delete, the row is restored for the next sweep.
- Removing or replacing a product photograph no longer deletes the file. The
  homepage hero and campaign images still delete a replaced file immediately:
  nothing else can refer to them.

**Consequences.** Uploads cost a few hundred milliseconds of CPU on the server.
Stored images are always `.webp`. Files uploaded before migration 0027 are not
in the registry and are never swept; they are few and all referenced by
existing rows. The sweep runs only as often as the job trigger does, which is
still subject to the hosting-plan decision in D-053.

## D-056 — One publish check for every way a listing goes live; publish dates are acted on

**Context.** `publishProduct` refused a listing without a category, a
photograph, something to buy, a price on every variant on sale, and a capacity
and closing date on every preorder. But it was not the only way to a status
shoppers can see: the create form offered "Preorder open" and "In stock", and
the ordinary product save accepted any status, so a listing with no photograph
and nothing to buy could be put live by either. Separately, the editor let staff
set "Publish on" and "Unpublish on" dates and said a scheduled job acted on
them; no such job existed, so a scheduled listing simply stayed a draft.

**Decision.**

- `assertReadyToPublish` (lib/catalog/readiness.ts) is the single gate. It runs
  in `publishProduct` and in `updateProduct` whenever an unpublished listing
  is given a public status. A listing already live may move between public
  statuses (open to closed, say) without being checked again.
- `createProduct` refuses a public status: a new listing cannot pass the check.
  The create form no longer offers a status; a listing is saved as a draft and
  published from the editor.
- A recurring job (`catalog.apply_publish_schedule`, every five minutes)
  publishes listings whose publish date has passed through the same gate, as
  preorder-open when it has preorder variants and in stock otherwise, and
  returns live listings to draft when their unpublish date passes. It acts on
  behalf of the staff member who last edited the listing, and only while they
  still have catalogue access, because the audit log records a person. Each
  date is claimed by clearing it in a guarded update; a refused publish puts
  the date back and is reported, and is tried again on the next run.

**Consequences.** Test fixtures that created live listings directly now use
`createProductForTest` (tests/helpers/catalog.ts), which creates through the
real function and then sets the status — a fixture shortcut, not an application
path. The schedule runs only as often as the job trigger does (D-053). A listing
whose date passed while unfinished stays a draft until it is finished and the
next run publishes it.

## D-057 — Nonce CSP with every page rendered per request; cross-site and rate limits at the edge; description HTML sanitised

**Context.** The production Content-Security-Policy allowed `'unsafe-inline'`
scripts, so an injected script element would have run. Nothing checked the
origin of cookie-authenticated API writes beyond the `SameSite=Lax` cookie.
Staff-typed description HTML was stored and rendered unsanitised, and JSON-LD
was serialised without escaping `<`. Only sign-in, two-factor and the
newsletter were rate limited.

**Decision.**

- `proxy.ts` issues a fresh nonce per page response:
  `script-src 'self' 'nonce-…' 'strict-dynamic'`, no `'unsafe-inline'` or
  `'unsafe-eval'` for scripts in production. Styles keep `'unsafe-inline'`,
  because the design uses style attributes, which a nonce cannot cover, and
  styles cannot run code.
- Next.js can put the nonce only on scripts it renders for the request. Pages
  whose shell was prerendered at build (static routes with a loading skeleton,
  such as /search and /cart) sent scripts with no nonce, and the browser
  refused them. The root layout therefore calls `connection()`: every page
  shell renders per request. Cached catalogue data and rendered sections are
  `use cache` entries and stay cached. Measured on `manifest_scale`, one
  process, 20 clients: no loss — root category 58 req/s, leaf 71, search 67,
  product 62, home 72, cart 175, help 166 (all at or above the Phase 10.1
  figures).
- `proxy.ts` refuses (403) API writes whose Origin is another host or that the
  browser marks cross-site; webhooks and the scheduler are exempt.
- Public writes are rate limited per hour in PostgreSQL: checkout 20 per
  address and 10 per email (an unpaid order holds preorder places), sign-up 10
  per address, guest order lookup 30 per address. All configurable
  (`CHECKOUT_RATE_LIMIT_PER_IP` and neighbours).
- Description HTML is sanitised with `sanitize-html` (a parser, not regular
  expressions) to the formatting the editor offers — on save and again at
  render for rows stored earlier. JSON-LD escapes `<`.

**Consequences.** A page can no longer be served from a build-time shell; the
measurements above show no throughput cost on this workload. Any future inline
script must be rendered by Next.js (to receive the nonce), not written into
HTML by hand. Password reset remains unbuilt and is documented as such.

## D-058 — A preorder without a capacity and a closing date is not open for orders

**Context.** The publish check (D-056) required a capacity and a closing date on
every preorder, but the cart and checkout read a blank capacity as unlimited and
a blank closing date as never closing. A listing published before the check,
or one whose values were cleared afterwards, could therefore be oversold or
stay open indefinitely. The owner decided (September 2026) that the publish
rule wins everywhere.

**Decision.**

- A preorder variant is open for orders only with both values set. The rule
  lives in `isUnconfiguredPreorder` / `offeredVariantSql`
  (`lib/catalog/price.ts`) and in the locked availability check
  (`lib/preorder/capacity.ts`, reason `not_open`).
- Applied at every point a shopper could order: the buy box does not offer the
  variant, cards do not quote its price, the "available now" filter does not
  count it, the cart refuses to add it and flags a line already there, the
  wishlist flags it, and placing an order refuses it inside the transaction
  before anything is reserved.
- Staff cannot clear either value on an enabled variant of a published listing
  (`updateVariant`), and opening a preorder window requires both
  (`openPreorder`). A draft can be edited freely.
- Unlimited preorders are not supported. If they are wanted later they need an
  explicit setting, never a blank field.

**Consequences.** Existing live listings with a blank value stop taking orders
until staff fill it in; the admin variant table labels them "Not orderable" and
the readiness panel lists what is missing. On the development database this
affects one listing (the Optoma projector). Tests that relied on uncapped
preorders now give a capacity large enough never to bind.

## D-059 — Jobs run only from a real scheduler, with intervals per job and per environment, and a heartbeat

**Context.** D-053 left the trigger frequency open. The owner decided
(September 2026) that production jobs must run from a real scheduler and never
depend on site traffic, and that frequency must be configurable per job and per
environment rather than one universal setting. Vercel Cron runs only on a
project's production deployment and, on the Hobby plan, at most daily; the
plan for production and the shape of staging are not yet fixed.

**Decision.**

- Each recurring job keeps its default interval in `lib/jobs/registry.ts`.
  An environment overrides any of them with `JOB_SCHEDULE`
  (`kind=minutes` or `kind=off`, comma-separated). A malformed entry keeps
  that job's default and is logged as `jobs.schedule_invalid`; a typo never
  switches a job off.
- Every call to `/api/cron/jobs` records a heartbeat
  (`scheduler_heartbeats`, migration 0030) and logs `jobs.trigger`. The job
  summary API and, for the owner, the admin overview say when the scheduler
  has not called in for three of the shortest intervals (at least 10 minutes),
  and what that stops.
- Triggers, none of which is site traffic:
  - Vercel Cron in `vercel.json` (daily, valid on every plan; on a paid plan
    change the jobs entry to `* * * * *`).
  - `.github/workflows/scheduler.yml`: an opt-in external scheduler for
    staging or production, enabled per environment by a repository variable,
    every 5 minutes.
  - Any other cron service calling `/api/cron/jobs` with `CRON_SECRET`.
  - `npm run jobs:dev` on a development machine.
- Requests may still *accelerate* work (placing an order tries to send its
  confirmation at once), but nothing depends on it: the scheduled delivery job
  sends whatever that attempt did not.

**Consequences.** Until a hosted environment has a trigger at least as frequent
as its shortest interval, the admin overview shows a warning, which is the
intent. Choosing the production trigger depends on the Vercel plan and is
BLOCKED on the owner's hosting account. The development site shows the warning
unless `npm run jobs:dev` is running with the server's `CRON_SECRET`.

## D-060 — One Product Knowledge Base under the storefront, SeoPulse and SearchPulse

**Context.** The owner started an eight-stage programme (tracked in
[KNOWLEDGE_PLATFORM.md](KNOWLEDGE_PLATFORM.md)) to make product knowledge a
long-term, reusable Manifest asset. The Stage 1 audit found facts about one
product spread over seven unsourced stores (`brand`, `identifier_*`,
`details`, `attribute_values`, `spec_table`, `measurements`, compliance JSON),
SeoPulse copying some of them into others (finding F1), and search and SEO
each reading their own selection of those stores.

**Decision.** Product facts get one home: a Product Knowledge Base in the same
PostgreSQL database, tables prefixed `pkb_`, code in `lib/pkb/`. The
storefront, SeoPulse and SearchPulse read it through read models and
projections; only `lib/pkb` review and apply services write accepted facts.
The existing modules keep their names — `lib/seo-pulse` is SeoPulse, and
SearchPulse is `lib/search` with `lib/catalog/{discovery,facets,filter-params}`
— rather than being renamed for the programme.

**Alternatives considered.** Adding provenance columns to the existing JSON
stores (keeps seven stores, cannot express evidence, conflicts or
relationships to products not sold); a separate database or service (a second
system to deploy and keep consistent, for a catalogue of hundreds to low
thousands of listings); a Postgres schema namespace instead of a prefix
(cleaner grants, but every raw SQL fragment, trigger and test helper would have
to qualify names; a prefix gives the same visible boundary for less friction).

**Why.** A single, relational, source-backed store is the only way to satisfy
"one source of truth", "provenance over unexplained values" and a future export
boundary at the same time. Keeping it in Postgres matches D-003 and D-026.

## D-061 — PKB product and variant are identity; the listing sells it; the variant row is the offer

**Decision.** `pkb_products` is what a thing is (brand, manufacturer, name,
model, generation, family, facts, identifiers, relationships). `pkb_variants`
is one concrete version defined by its variant-defining attributes. `products`
stays Manifest's listing (title, slug, status, photography, copy, SEO fields)
and points at a PKB product through `products.pkb_product_id`.
`product_variants` stays the offer (BDT price, sale window, stock, preorder
capacity, payment mode, merchant SKU, shipping weight) and points at a PKB
variant through `product_variants.pkb_variant_id`. The existing option tables
remain the listing's selection axes and combination engine (D-006, D-040), with
`attributes.attribute_definition_id` linking an option to the vocabulary.

**Alternatives considered.** Keeping `products` as the identity and adding
facts to it. Rejected: compatibility, accessory and predecessor relationships
must be able to name products Manifest does not sell, and the reusable asset
must not carry prices, capacity or merchandising.

**Why.** Offer data changes daily and belongs to one shop; identity and facts
are stable and reusable. `product_variants.weight_grams` is kept as the
shipping weight used by landed-price bookkeeping; the published item weight is
a PKB fact. They are different quantities, documented rather than merged.

## D-062 — Facts, claims and evidence are relational rows; JSON only for small bounded configuration

**Decision.** Accepted values live in `pkb_facts`, one row per single-valued
slot or per option of a multi-valued one, with typed normalized columns
(`value_text`, `value_number`, `value_number_to`, `value_unit`,
`value_boolean`, `value_date`, `option_id`), an explicit `value_status`
(`value` or `not_applicable`) and the raw source text and unit. Proposed values
live in `pkb_claims`, each tied to a `pkb_evidence` excerpt of a `pkb_sources`
row. Prior values go to append-only `pkb_fact_history`. Identifiers,
relationships and aliases have their own tables with foreign keys. JSON is used
only for small configuration that is never queried on (definition validation
rules) and for SeoPulse run payloads that are stored and exported as a unit.

**Alternatives considered.** One JSON document per product with per-key
provenance (keeps the weakness of D-025: no constraints and no indexing by
value, so no facet read model); a generic entity-attribute table without typed
columns (numeric comparison and unit conversion would happen in application
code on every read).

**Why.** Typed rows let the database enforce uniqueness and value shape, let
facets and search filter numerically ("512 GB and above"), and make "which
values came from where" a query. This supersedes D-025 once the migration in
D-069 contracts `products.attribute_values`.

## D-063 — Verification states, origin classes and authority tiers

**Decision.**

- Slot states: VERIFIED, SUGGESTED, CONFLICT, UNVERIFIED, MANUAL, LEGACY,
  LOCKED. Facts store VERIFIED, MANUAL, UNVERIFIED or LEGACY; claims store
  SUGGESTED or CONFLICT (then ACCEPTED, REJECTED or SUPERSEDED). LOCKED is
  `locked_at`/`locked_by` beside the underlying state and is reported as the
  effective state. A slot with neither fact nor claim is UNKNOWN, which is never
  stored as false, zero or not applicable.
- Origin classes on sources, copied to facts: MANIFEST_CREATED, MANUAL_ADMIN,
  OFFICIAL_MANUFACTURER, APPROVED_EXTERNAL_SOURCE, SUPPLIER_PROVIDED,
  PROVIDER_RESTRICTED, CUSTOMER_DERIVED, UNKNOWN_LEGACY. Sources also carry
  usage rights (internal_only, display, exportable, unknown).
- Authority tiers: 1 official manufacturer; 2 authorized distributor, trusted
  retailer, reliable product database; 3 other approved public sources.
  Unlisted domains have no tier and cannot verify anything on their own.
- Verification is evidence-policy driven (amended at the start of Stage 2 on
  the owner's instruction). Official manufacturer evidence is the preferred,
  highest-authority path but not the only one: a verification policy decides
  which evidence may support VERIFIED — authoritative manufacturer
  documentation, approved manufacturer or supplier feeds, official
  documentation an admin provides, and other explicitly trusted sources —
  depending on the product and the evidence available. Evidence no policy
  accepts is never silently promoted; accepted without qualifying evidence it
  is UNVERIFIED. Typed by staff is MANUAL; backfilled is LEGACY with
  UNKNOWN_LEGACY origin. Nothing is promoted by a migration or by AI. AI may
  locate an excerpt in a real source or write SEO language; it is never a
  source and never decides a fact.
- Every source records its type, how it was acquired and its authority, and
  every fact records its source, so each VERIFIED value's basis can be shown
  and re-evaluated when a policy changes.
- The database refuses a VERIFIED fact without an accepted claim (which
  requires evidence) and a decision basis: the deciding admin, or the key of
  the verification policy that authorized it. The policy engine is Stage 3.

**Why a lock is not a state value.** A locked value was still either verified
or entered by hand; overwriting that with LOCKED would lose it, and unlocking
would have nothing to return to.

**Superseded assumption.** Stage 1 assumed VERIFIED would require tier-1
evidence only (A-4). The owner replaced that with the policy-driven rule above.

## D-064 — Product Families are data, versioned, and never forced

**Decision.** `pkb_families` (optionally with a parent) own versioned schemas
(`pkb_family_versions`) that list global attribute definitions
(`pkb_attribute_definitions`) with a requirement level (required, recommended,
optional), a variant-defining flag and optional overrides of the searchable,
filterable, SEO and structured-data flags. Completeness is measured against
the family's active version. A product with no suitable family is
`unassigned`; a proposed family is `suggested` until someone with the new
`knowledge.manage` permission approves it. Removing a definition from a family
creates a new version and never deletes facts. `categories` stays the
navigation tree and may name a default family to suggest on create.
`category_attributes` is migrated into families and retired (D-069).

**Alternatives considered.** Keeping specifications per category (a kind of
product can sit on several shelves, a shelf can mix kinds of product, and
navigation changes should not rewrite product schemas); hard-coded families in
code (every new kind of product becomes a deploy).

**Why.** Adding a new kind of product must be a data operation. The only code
change a new category can need is a new unit dimension (D-065).

**Assumption for the owner (A-3).** Categories that already define
specifications become approved families on backfill, because staff authored
those definitions.

## D-065 — Deterministic normalization with a code-defined unit registry

**Decision.** Units are a registry in `lib/pkb/units.ts` (dimension, canonical
unit, aliases, conversion), not a table: mass g, length mm, data storage byte
(decimal GB; GiB separate), frequency Hz, power W, energy Wh, charge mAh,
voltage V, current A, duration s, volume mL, temperature °C, pixel count px.
Quantities are stored in the canonical unit with the raw text and unit kept.
Unparseable input is kept raw, with no normalized value, and flagged. Enum
values normalize through option keys and aliases; identifiers by type (GTIN
digits with a validated check digit; MPN folded for matching). Stage 5 search
normalization reuses the same rules so a query and a fact normalize alike.

**Alternatives considered.** A units table staff can edit (conversion factors
are physics, and a wrong factor silently corrupts every fact of that
dimension); AI normalization (non-deterministic and unverifiable).

## D-066 — SeoPulse proposes; `lib/pkb` decides

**Decision.** SeoPulse owns product resolution, the brand source registry,
source retrieval, extraction, claim normalization and validation, conflict
detection, completeness, attribute discovery proposals, SEO suggestions,
technical SEO audits, structured data and Search Console intelligence. It
writes sources, evidence, claims, research runs, SEO suggestions and audit
results — never accepted facts. Accept, reject, edit, lock, resolve conflict
and schema approval are `lib/pkb` services with a server-side permission check,
one transaction, history and audit. Research and retrieval run as background
jobs (D-053). Any outbound fetch goes through a guard against private,
loopback and metadata addresses (checked after DNS resolution and on every
redirect), with timeouts, size caps and robots.txt respected; the guard ships
with the fetcher in Stage 3.

**Source acquisition is provider-agnostic** (amended at the start of Stage 2 on
the owner's instruction; replaces the Stage 1 assumption that automatic
discovery needs a paid search service). Sources may come from Brand Source
Registry domains, staff-provided URLs, staff-provided documents or data,
approved manufacturer or supplier feeds, lawful public or free mechanisms where
implemented, and optional `ProductResearchProvider` implementations added
later. Each source records its `acquisition_method`. When automatic discovery
is unavailable, the pipeline reports NOT_CONFIGURED or UNAVAILABLE and never
invents a source, URL or value.

**Supersedes in part.** D-040's one-click fill that writes into empty fields,
and D-043's derived specification and measurement tables being written to the
listing. Both become proposals shown for review (assumption A-5); the tables
are rendered from facts instead of being copied.

## D-067 — SearchPulse reads the PKB through read models and proposes aliases

**Decision.** Search stays in Postgres (D-026 reaffirmed).
`refresh_product_search` and the facet queries move to reading accepted,
displayable, searchable PKB facts through read models instead of `details`,
`attribute_values` and `spec_table`. Entity aliases ("XM6" for WH-1000XM6,
"Logitec" for Logitech) live in `pkb_aliases` with status and origin;
SearchPulse may suggest them from zero-result analytics, and only
`search.manage` approves them. `search_synonyms` remains the table for
term-level synonyms. Search analytics stay hashed and free of account ids;
`search_history` stays customer data and never feeds the PKB except as
aggregated, thresholded counts.

## D-068 — The future API boundary is a DTO layer with one export-eligibility rule

**Decision.** No API is built now. `lib/pkb/export.ts` will serialize only
facts whose origin, usage rights and state pass one tested eligibility
function, with public identifiers and without actor columns, internal notes,
costs, offers or provider-restricted data (DataForSEO, Search Console). No code
outside `lib/` reads `pkb_*` tables, as for every other table.

**Why.** "Which pieces of this dataset may leave Manifest?" must be answerable
from stored classifications, not reconstructed from memory later.

## D-069 — Migrate by expand, backfill, cut over, contract

**Decision.**

1. Expand: new numbered migrations create `pkb_*` tables and nullable link
   columns; nothing existing changes meaning.
2. Backfill: an idempotent TypeScript command and job (so it shares the live
   normalization code) creates brands (exact normalized matches only), PKB
   products and variants, identifiers and LEGACY facts with
   `origin = UNKNOWN_LEGACY` and a `legacy_ref` per source column; unmatched
   rows go to `pkb_unmapped_values`; a reconciliation report must be clean.
3. Cut over writes: editor panels write through `lib/pkb`, which rewrites the
   legacy columns as projections in the same transaction, so existing readers
   keep working. After cut-over only the projection writes a legacy column.
4. Move readers: structured data, product page, search trigger and facets read
   PKB read models (Stages 4 and 5).
5. Contract: drop a legacy column or `category_attributes` only when no reader
   remains (enforced by a test) and the reconciliation report is clean on the
   target database (Stage 7).

**Alternatives considered.** A one-shot rewrite of the product model (breaks
every reader at once, against CLAUDE.md §5); dual writes from each screen (two
code paths that drift); a SQL-only backfill (would duplicate the unit and
identifier parsing in PL/pgSQL).

**Why.** Every step leaves the storefront working and is reversible until the
contract step, which only removes what nothing reads.

## D-070 — While the editor still writes legacy columns, the knowledge base mirrors them, attributed, in the same transaction

**Context.** Stage 2 builds the knowledge base, but the product editor, the
category specification screen and the variant screens still write the legacy
columns (`brand`, `details`, `attribute_values`, `spec_table`, `measurements`,
`box_contents`, the identifier columns, variant options). A backfill alone would
be stale after the next save — a second, drifting copy of the same facts, the
exact thing this programme exists to remove.

**Decision.**

- Every staff write path that changes those columns runs
  `syncListingKnowledge` inside its own transaction: product create, update,
  duplicate and delete; variant generate, add and remove; category and category
  specification create, update and delete. The knowledge base therefore agrees
  with the listing at commit.
- Changes are attributed. A staff save makes the values it *changed* MANUAL,
  with the staff member as decider and a `staff_entry` source; a duplicated
  listing's copied values are UNVERIFIED; anything unattributed is LEGACY with
  UNKNOWN_LEGACY origin. A value's state follows its raw text: saving a panel
  without editing a value never turns LEGACY into MANUAL.
- Before a staff transaction writes, `beginListingChange` takes the listing's
  knowledge lock and settles any change another path left waiting as
  unattributed, so the save is credited only with its own edits.
- Triggers on those columns queue the listing in `pkb_sync_queue`; the
  `pkb.sync_listings` job (every 5 minutes) processes anything a staff
  transaction did not — imports, scripts, category moves. The migration queues
  every existing listing, so a deploy imports them without a manual step.
- Nothing automatic overwrites a decided value. A staff save that would change
  a locked value is refused and rolls back. An unattributed change to a MANUAL,
  UNVERIFIED, VERIFIED or locked value is not applied; the knowledge base's
  value is written back to the listing, and the attempt is kept in
  `pkb_unmapped_values` until someone dismisses it.
- Values written directly in the knowledge base (`setFact`) are written back to
  the listing when its columns can show them (brand, details, category
  specifications, box contents, country of origin, identifier). A value from a
  column that cannot be written back — a specification-table row, a variant
  option — stops mirroring, and a later disagreeing row is parked, not applied.
- Anything that cannot be placed without guessing — a specification row whose
  label names no attribute exactly, an option with no definition, a value that
  collides with a structured one, a GTIN already held by another product — is
  parked in `pkb_unmapped_values`, never forced.
- Mapping is conservative: labels match a definition only by exact label, key
  or approved alias; a label two definitions answer to is ambiguous and parked.
  One definition is created per category specification; duplicates across
  categories are not merged by guess.
- A deleted listing's knowledge record is removed only when it holds nothing
  but what was mirrored from that listing. Evidence, claims, relationships,
  aliases, knowledge-native values or another listing keep it.

**Alternatives considered.** Backfill only, until the editor is rebuilt (stale
from the first save); an application-side hook in the shared transaction
wrapper (implicit, and silently skipped in any process that never imports the
knowledge module); making every attribution come from a transaction-local
setting read by triggers (still needs every path to set it, and a trigger
cannot run the TypeScript normalization).

**Cost.** A product save does the sync's reads and diff (measured in
KNOWLEDGE_PLATFORM.md). Two found and fixed on the way: `updateProduct` read
the slug through the shared connection inside its transaction (a hang on the
single-connection test database once the transaction issued a statement first);
and the local PostgreSQL server's WIN1252 encoding cannot store `→` in migration
text.

**Assumption for the owner (A-7).** Copied values of a duplicated listing are
UNVERIFIED rather than MANUAL: duplicating is usually the start of a different
product, and nobody has checked those values for it.

## D-071 — Owner decisions at the start of Stage 3: legacy stays legacy, reviewed label mapping, existence is not trust, identifier history

**Decided by the owner (September 2026), on assumptions A-7 to A-9 and risk R-6.**

- **A-7 approved.** Migrated and copied listing facts stay unchecked (LEGACY,
  or UNVERIFIED for a duplicated listing) until they independently satisfy the
  verification policy with evidence and decision history. Migration never
  produces VERIFIED.
- **A-8 approved with controlled expansion.** Exact label, key or approved
  alias matching remains the only automatic mapping. A reviewed mapping
  workflow is added: staff approve that a label maps to an attribute, or is not
  an attribute, and the decision is kept as reusable knowledge — scoped to a
  family where the same label means different things in different families —
  so later rows with that label map deterministically. No fuzzy matching. The
  unmatched development rows are reviewed through this workflow.
- **A-9 modified.** Brand existence and source trust are separate things. A
  brand in the catalogue is valid without approval. Official product and
  documentation domains, source preferences, manufacturer identity mappings
  and any other trust assertion start SUGGESTED and carry no authority until an
  approved decision or evidence supports them.
- **R-6.** Identifier changes are auditable: previous value, new value, actor
  or source, time and reason, in an append-only history. Invalid identifiers
  keep their original text and are marked invalid; a check digit is never
  corrected by guessing.
- **Network safety.** Protections against SSRF (loopback, private and internal
  ranges, cloud metadata endpoints, unsafe redirects, DNS rebinding), with
  timeouts, response-size limits, protocol restrictions and safe parsing, ship
  in the same change as the first code that retrieves an external source.

## D-072 — Product resolution gates factual enrichment, and label mappings are reviewed once

Enrichment only runs on a product whose identity is settled. `assessResolution`
derives one of four states from the product's own identifiers: VERIFIED (a
person confirmed it, and the identity signature has not changed since),
HIGH_CONFIDENCE (a brand plus a model key or a valid GTIN, with no candidate it
could be confused with), AMBIGUOUS (another knowledge product shares the brand
and model key, or the identifier claims disagree) and UNRESOLVED (no brand and
no identifier). `canEnrich` allows the first two. Asking for a run re-checks the
state rather than trusting the stored one, and a blocked run is recorded with
its reason instead of failing silently.

Confirming an identity requires a note of at least five characters and records
the products this one is explicitly *not* (`pkb_identity_distinctions`), because
"this is the 256 GB, not the 512 GB" is the fact that stops the next run from
mixing them.

Labels are placed by exact match only. Anything else waits in
`pkb_unmapped_values`, and a person either maps it to an attribute or marks it
not an attribute; the decision is stored in `pkb_label_mappings`, scoped to a
context (`spec_table`, `measurements`, `variant_option`, `source_document` or
`any`) and optionally to one family, and is then applied deterministically to
every later row with that label. Deciding queues the listings the decision
touches, so the values are placed by the ordinary sync rather than edited in
place. Retiring a mapping queues them again. There is no fuzzy matching (A-8).

## D-073 — Attribute discovery proposes; a person decides what an attribute is

A label an extraction found and nothing names becomes a row in
`pkb_attribute_proposals`, holding the label, one example value, a guessed shape
and the evidence. `guessShape` is a default on the review screen, never a
reason to store anything.

Three answers exist. **Add to Family** puts the attribute in the family's
schema: for a family mirrored from a category the specification is added to the
category (so the mirror keeps it), otherwise `addAttributeToFamily` drafts and
activates a new family version inside the same transaction. **Product only**
defines the attribute without touching the family. **Ignore** records that the
label is not an attribute. Every answer writes a reusable label mapping, and an
accepted proposal creates a claim from its evidence — so even an accepted
proposal's value is reviewed before it becomes a fact.

## D-074 — The enrichment pipeline retrieves, quotes and proposes; it never writes a fact

A run is `pkb_enrichment_runs`; the work happens in the `pkb.enrich_product`
job, never in a staff request. Sources come from three places, none of which
requires a paid provider (A-6): approved registry entries for the product's
trusted brands (including URL templates filled from its own identifiers), pages
staff attached to the product, and a `ProductResearchProvider` if one is
configured. With none configured the provider reports `NOT_CONFIGURED` and the
run records that, rather than treating "no discovery" as "no sources exist".

Every retrieval goes through `robotsAllows`/`checkRobots` and `safeFetch`: a
blocked registry domain, a robots.txt refusal, an unreadable robots.txt, a 401,
403 or 429, a redirect into a private address, an oversized body or a wrong
content type is stored as a refused `pkb_source_documents` row with its reason.
Nothing bypasses an access control.

A retrieved document is only used when its own identity signals agree with the
product's: a shared GTIN or model key is agreement, a different one of the same
kind is disagreement, and anything weaker is `unknown`. Only `match` documents
produce claims; the others are kept as a record and produce nothing. One value
per slot per document, so a page repeating a specification does not corroborate
itself.

## D-075 — SEO Pulse: generated wording is proposed, an apply is one transaction, research runs as a job

Three changes close the Stage 1 findings F2 to F4.

- **Fill proposes generated text.** With an AI generator configured, one-click
  Fill writes nothing: the description, key features, meta text and term lists
  come back as `proposed` entries for field-by-field review. With the rules
  generator, Fill still fills — every value it produces is derived from facts
  the listing already records. The specification and measurement tables are no
  longer written by SEO Pulse at all; they belong to the knowledge base, which
  mirrors them with provenance (F1).
- **An apply is atomic.** `applySeoPulse` opens one transaction and threads it
  through `updateProduct`, `updateProductImageAltText` and `createSynonym`,
  each of which now takes an optional executor. A failure part-way leaves the
  listing untouched.
- **Research runs off the request path.** When an external provider is
  configured (`usesExternalProviders`), `runSeoPulse` records a `running` run
  and enqueues `seo.research_product`; `completeQueuedResearch` finishes it and
  is idempotent, so a retried job cannot overwrite a completed analysis. With
  only the local rules generator, research still runs inline and the answer is
  immediate.

## D-076 — Review is explicit: named claims, all or nothing, and VERIFIED only under a policy

Accepting, rejecting, correcting and resolving all name the claims they act on;
there is no "apply everything". Accepting several claims writes them in one
transaction or not at all, and two claims for one slot in a single action are
refused rather than silently ordered.

A claim becomes VERIFIED only when `evaluateVerification` finds an active
verification policy that its evidence satisfies at that moment — by source
type, registry role, authority tier and the number of independent sources.
Otherwise it is accepted as UNVERIFIED with its provenance intact. A locked
value is never replaced, and a value staff entered or verified is replaced only
with an explicit override. A slot with conflicting claims is settled by
choosing between them, never by overwriting one with the other.

## D-077 — Every SEO field says who decided it, and a lock stops automation

`seo_field_states` records one state per listing field: AUTO (nobody has
decided), SUGGESTED (a generator proposed the wording), MANUAL (a person wrote
it) and LOCKED (a person fixed it). `seo_field_history` keeps the before and
after of every change with the actor and the reason, which the `product.updated`
audit entry never did (finding F9).

The state governs automation, not people: staff can always edit a field through
the editor, and doing so makes it MANUAL. An automatic path — an accepted SEO
Pulse recommendation included — is refused on a LOCKED field with a message
naming the field, rather than quietly skipping it, because a silent skip is how
a person comes to believe an apply did something it did not. A locked field a
person edits stays locked; unlocking is its own action. Locking an empty field
is refused: it would only stop the field ever being filled.

## D-078 — A listing keeps its address once shoppers have seen it, and old addresses redirect

Two rules close finding F5.

First, the address follows the title only while the listing is a draft nobody
has seen. `products.first_published_at` records the first time it reached a
public status and is never reset, so a listing taken back to draft still keeps
its address. After that the address changes only when a person sets it.

Second, `product_slug_redirects` holds every address a listing has left, and the
product page answers an old address with a permanent redirect to the current
one. A redirect never shadows a live address: the row is refused if another
listing holds that address now, and taking an address back deletes the redirect
from it, so a loop cannot form.

## D-079 — A canonical address may only point at this site

`canonical_url` used to accept any http(s) address. A canonical pointing at
another domain tells search engines that this page is a copy of that one, and
the shop's own page drops out of the results — a one-field way to deindex a
listing, reachable by anyone who can edit a product (finding F6). The field now
takes a path (`/products/example`) or an absolute address on the site's own
origin, and nothing else. Values stored before this are reported on the SEO
health screen rather than silently rewritten.

## D-080 — Structured data is built from the page and the knowledge base, never from either alone

The product page's JSON-LD is assembled in `lib/seo/structured-data.ts` from
three sources and no others.

- **The page's own values.** The description is the visible product copy with
  its markup stripped, not the meta description a shopper never sees (finding
  F7). Prices come from the same query the buy box renders, and availability
  from the same `stockState` function, so the rich result cannot contradict the
  page (finding F16).
- **Established knowledge.** Brand and identifiers come through
  `publishableKnowledge`, which returns a value only when it is VERIFIED or
  staff-entered (invariant I-11). An unchecked legacy identifier is not
  published: in a rich result it is worse than none.
- **Nothing else.** No rating without approved reviews, no shipping or return
  policy the shop has not published, no invented GTIN.

A listing whose offers differ by an option is a `ProductGroup` with one
`Offer` per variant, each with its own price, availability and identifiers;
several offers that do not differ by an option become an `AggregateOffer` with
a real range. A listing with nothing to sell is still described, but states no
price.

## D-081 — Readiness is a list of measurable checks; there is no score

`lib/seo/readiness.ts` replaces the two weighted 0–100 numbers (finding F13).
Each check states a fact about a field on this listing — "38 characters", "2 of
5 photographs need a description" — with a severity in words (`required`,
`recommended`, `optional`) and, when it fails, the fix. Runs record how many
checks passed out of how many were checked; the old score columns stay for
runs recorded before Stage 4 and are labelled as such.

The catalogue-wide view, `lib/seo/health.ts` behind `/admin/seo-health`, is the
same idea at scale: every figure is a count from a query over published
listings, with examples to start from, and there is deliberately no site score.
A single number would invite arguing with the number instead of fixing the
listings, and nothing this shop can compute predicts a ranking.

## D-082 — The sitemap lists what exists and what changed

Three corrections (finding F15). A category with nothing published in it or
beneath it is left out, because a crawler that follows it finds an empty page.
A listing hidden from search is left out. And `lastModified` is the latest of
the listing row, its photographs and its offers, so a price or a new photograph
tells a crawler the page changed — which `products.updated_at` alone did not.
Gallery photographs are listed as image entries, in the order the page shows
them.

## D-083 — Internal links come from accepted relationships only

A product page links to the accessory that fits it, the model it replaced and
the rest of its series, from `pkb_relationships` — which holds only
relationships a person accepted. Nothing infers a connection from text, and a
relationship pointing at a knowledge product with no public listing is not
rendered, because the link would be a dead end. With no recorded relationship
the block does not appear and the page keeps the category row it always had.

## D-084 — A shelf is a page of its own, with its own SEO fields

Every category page carried the same generated sentence with the shelf name
swapped in, and its title was the bare name. That is the shop publishing its
own near-duplicate content across a dozen pages. Migration 0035 gives
`categories` the same four fields a listing has — `seo_meta_title`,
`seo_meta_description`, `seo_no_index`, `canonical_url` — plus `intro_html`, a
paragraph or two of real copy shown at the top of the shelf. The generated
sentence remains the fallback, and the SEO Health Center counts every shelf
that still relies on it. The category tree's rename form keeps sending only
name, slug and parent: the SEO fields follow the product patch rule, where an
absent field is left alone and null clears it, so a rename can never wipe copy
somebody wrote. `intro_html` is staff-authored HTML and is reduced to the
allow-list in `lib/html/rich-text.ts` before it is stored (D-057). A shelf
hidden from search leaves the sitemap and sends a noindex header; it stays
reachable on the site, because hiding a page from Google is not the same as
taking it away from shoppers.

## D-085 — Image SEO reports what is measurable and suggests only what is established

`lib/seo/images.ts` says, per listing and across the catalogue: a photograph
with nothing describing it, the same sentence pasted onto two angles, a file
under 800px on its longest edge, a file over 600 KB, and a file with no size
recorded at all. Dimensions and weight come from `media_objects`, the registry
every upload writes to; a photograph with no row there has an *unknown* size,
which is reported as unknown rather than assumed.

`suggestAltText` builds a sentence from the brand, the listing's name and a
colour or material — and only when the knowledge base holds that value as
VERIFIED or a person typed it. It never describes the picture itself ("front
view", "on a wooden desk"), because the module has not seen the picture, and
alt text that describes the wrong photograph is worse than none. The suggestion
is shown to a person; no job writes it.

## D-086 — Duplicate and thin content are detected, never rewritten

`lib/seo/duplicates.ts` finds listings that share an SEO title, a meta
description, a product name or a description body word for word, plus bodies
that open with the same 160 characters and diverge later — the shape a template
leaves behind. Thin pages are counted by what is actually on them: characters
of readable text, key features, specifications.

Exact matches group on the normalized value, which migration 0035 indexes.
Near-duplicates bucket on the opening of the stripped body and compare only
inside a bucket, so the work grows with the catalogue rather than with its
square, and no derived fingerprint table has to be kept in step with the copy.

Nothing is rewritten. Which of two pages keeps the wording is a merchandising
decision, and the module's job is to put the pair in front of somebody.

## D-087 — Technical auditing asks what this shop can answer

`lib/seo/technical.ts` checks only what the shop's own rows can settle: whether
a page is public and indexable and why not, whether its canonical points at
itself, whether an old address has been taken over by a live listing so the
redirect never runs, whether a redirect now leads to a draft, whether the shelf
above it is hidden, whether the address falls under a robots.txt disallow, and
whether the page has an offer to state a price with. What Google has actually
done with the page is Search Console's answer and belongs to Stage 6; guessing
at it here would be a fabricated number.

Nothing is repaired automatically. A redirect that shadows a live address, for
instance, is reported: deleting either side could break a link that is already
out in the world, and which one to move is a person's call.

## D-088 — Link intelligence suggests pairs; relationships stay claims

`linkIntelligence` counts listings nothing links to, accepted relationships
that cannot be rendered because the other side has no public listing, and pairs
that share an established brand and product family with no relationship between
them. The last are suggestions with their reason stated, shown to staff.

They are not created. A relationship is a claim about the products, and a claim
is decided in the knowledge base with evidence behind it (I-1, D-076). Inferring
one from a shared brand would put an unevidenced fact into the same table that
holds the reviewed ones.

## D-089 — Search reads the knowledge base through one derived index; parity is by construction

**Decision.** `product_search` gains four derived columns — `brand_key`,
`family_keys`, `alias_keys` and `terms` — built by `refresh_product_search`
from `pkb_facts`, `pkb_identifiers`, `pkb_aliases`, `pkb_brands` and
`pkb_families` (migration 0036). `terms` is a prefixed text array: `p:` the
knowledge product, `b:` its brand, `f:` a family it belongs to, `a:` a named
attribute with a named value, `v:` that value whichever attribute holds it,
`q:` a named quantity in its canonical unit, `u:` that quantity by dimension.
A query is turned into the same forms by `lib/search/terms.ts` and
`lib/search/knowledge.ts`, and a slot matches through its words *or* one of its
terms — never both required, so adding the knowledge base to an existing search
can only ever find more.

Search holds no product truth of its own. Everything above is derived and can
be dropped and rebuilt from `pkb_*` by `refresh_product_search` at any time,
which is the test of whether a second source of truth has been created.

**Normalization parity is structural, not maintained.** A quantity is
normalized once, by `lib/pkb/units.ts`, when the fact is written; the index
copies the canonical number. A query goes through the same registry at query
time. There is no second unit table and no SQL unit conversion, so the two
cannot drift by one being updated and the other forgotten. The one rule that
does exist twice is the comparison key: `search_term_key` in SQL, because the
index is trigger-built, and `termKey` in TypeScript. They are character for
character the same, and `tests/search-knowledge.test.ts` runs both over the
same inputs and fails if they ever differ.

**Alternatives considered.** Building the index from application code after
every write (D-026 rejected this once already: it depends on every present and
future write path remembering to call it, and triggers cannot be forgotten).
Normalizing quantities in SQL (would mean a second unit registry, which D-065
rejected for the same reason). A separate search service (D-026 stands).

**Cost.** `refresh_product_search` is a larger function and reads eight more
tables. Accepting a claim or approving an alias now queues a listing for
reindexing, through new triggers on `pkb_facts`, `pkb_identifiers`,
`pkb_products`, `pkb_aliases`, `pkb_brands`, `pkb_attribute_definitions` and
`pkb_family_versions`. They use the same deferred queue as migration 0014, so a
listing changed many times in one transaction is still rebuilt once.

**Accents are not folded**, on either side. D-026 already said so for the
full-text side; folding on one side only would make "Crème" findable by neither
spelling.

## D-090 — Facets come from a derived read model, with the keys they used to travel under

**Decision.** `product_search_attributes` holds one row per product, attribute
and distinct value: the canonical URL key, the label, the comparison key of the
value, the value as it reads, its number and unit, and whether it is searchable
and filterable. It is built from the knowledge base where the knowledge base
has the value, and from the listing's own option groups and category
specifications where it does not — never both for one value, so nothing is
counted twice. The storefront's filters, counts and facet lists all read it.

This is what closes findings F11 and F12. "Color" and "Colour" are one filter
because they are one attribute definition; "256GB" and "256 GB" are one value
because both normalized to the same number of bytes.

**Old links keep working.** Every row carries `alt_keys` (the keys the
attribute used to answer to — its label, the category specifications mapped
onto it, the option groups linked to it) and `value_alt_keys` (the spellings
the value used to be filtered by, and the one it now reads as). A filter that
arrives under any of them is resolved to the canonical pair before anything
else sees it, so `?colour=black`, `?color=Black` and `?color=black` are one
filter with one value, and a link shared before the reconciliation opens the
same page it always did.

**Legacy values stay in.** An option group the knowledge base has no definition
for yet, and a category specification it has not mapped, are still indexed and
still filterable, marked `legacy_option` and `legacy_spec`. Dropping them would
have removed working filters from the storefront on the day the knowledge base
happened not to know something. Stage 7 contracts them when nothing reads them.

**Brand is not offered as an attribute facet**, although it is in the read
model: it has a control of its own, and two filters for one thing is worse than
one. The brand control now groups by the knowledge base's brand entity, which
closes finding F10 for the storefront.

## D-091 — Knowledge sits at the top and the bottom of the ranking, never in the middle

**Decision.** The relevance tiers of D-027 keep their meaning and gain one at
each end:

- **10** the whole search is an approved alias of exactly one product;
- **1** (the existing bottom tier) a listing that matched only through an
  attribute term.

An alias naming one product is as exact as a barcode, so it sits with the code
tier. An attribute match — "black", "512gb" — is the weakest evidence there is,
so a listing that answers only by carrying the right colour can never climb
above one whose name is what was typed. Everything between is unchanged.

An alias only names a product when it is the *entire* search. "xm6" is that
product; "xm6 case" is a search for a case.

**Typed quantities are left out of the tier judgement.** The tier asks how much
of the search a listing's name, brand or specifications contain. "512gb" is not
a word a name is expected to carry, so including it would drop every result of
"iphone 512gb" into the bottom tier together and flatten the ranking of an
otherwise ordinary search. `readableTsquery` is the tsquery without those
positions; the full one is still what decides whether a listing matches at all.

## D-092 — Autocomplete names things as the catalogue names them

**Decision.** Suggestions add two knowledge-backed sources: brands, grouped by
the knowledge base's brand entity so a brand spelled two ways is offered once;
and approved aliases, which suggest the *name* they stand for rather than
themselves — someone typing "xm" is offered "WH-1000XM6", because that is what
the catalogue answers to best. Both go through the public predicate, both are
capped, and nothing is loaded into the browser.

## D-093 — First-party search events, and conversion measured only where it is real

**Decision.** `search_events` records four kinds beside the existing query and
click logs: a filter used, a search rephrased, a result added to a cart, and a
search that ended in a confirmed payment. The privacy rules of D-029 hold
throughout — a daily-rotating visitor hash, never an account id, and a search
shaped like an email address or a phone number is not recorded at all. A
**filter event keeps only the filter keys**, never the values: what someone
narrows to is far more identifying than that they narrowed.

**Conversion is attributed along a path that can honestly be followed.** When a
result is opened, the click beacon leaves a short-lived first-party cookie
naming that one search and that one product. If the product goes into the cart,
the cart line remembers the search; at checkout the order line carries it; and
when the payment is confirmed it becomes a `purchase` event and the column is
**cleared**. So no order keeps a lasting record of what its customer searched
for, the count is idempotent (a webhook delivered twice finds nothing left to
count), and a purchase row carries no visitor at all, because by then it is a
fact about the catalogue.

**This supersedes part of D-029**, which said conversion could not be measured
and would be reported as not measured. It can be measured along this path. What
still cannot be — someone who searches, leaves, and buys tomorrow — is stated
on the report rather than approximated, which is the rule D-029 was protecting.

**Nothing here reaches the Product Knowledge Base** (invariant I-9). The
knowledge base learns from search behaviour only through the zero-result
screen, where a person decides.

## D-094 — A search that found nothing gets a verdict, not a row in a list

**Decision.** `zeroResultIntelligence` classifies each zero-result search as
one of seven: a misspelling the catalogue can correct, another name for
something the shop sells, a combination nothing has, something that exists but
is not visible, a shelf with nothing on it, a product not stocked, or a search
about something else. Each carries the evidence behind the verdict — the
correction, the hidden listings, the part of the search that makes it
impossible, the parts that do find something — and a recommendation in words.

Four of the seven are not search faults at all, and saying so is the point: a
list of words staff are expected to fix implies every one of them is fixable.

**A customer's words never become search vocabulary on their own.** The screen
can propose an alias; pressing the button creates a *suggested* one; approving
it is a separate `search.manage` decision (D-067). Two deliberate human steps,
because an alias taken from whatever people type would let anyone who searches
enough teach the shop what their words mean.

## D-095 — The legacy search path is kept until it is provably unused

**Decision.** Migration 0036 adds to the search index and the facets; it
removes nothing. The weighted document, the ranking tiers, the typo
vocabulary, `search_synonyms`, `search_queries`, `search_clicks` and
`search_history` all keep their meaning, and the legacy option groups and
category specifications stay in the facet read model beside the knowledge ones.

**Why.** The storefront's search and filters already worked. A migration that
replaced their sources in one step would have been a rewrite of a working
system, and any value the knowledge base did not happen to hold would have
silently disappeared from the shop. Keeping both, with each row saying which it
came from, makes the coverage measurable instead of assumed: `source` on
`product_search_attributes` counts exactly how much of the catalogue has moved.

Removal belongs to Stage 7, after the reconciliation report is clean on the
target database and a test proves no reader remains (invariant I-12).

## D-096 — Search Console is an optional intelligence source behind a provider boundary

**Decision.** `lib/providers/search-console/` defines one interface with two
methods: what is configured, and one page of performance rows. The default
implementation reports `NOT_CONFIGURED`; `GoogleSearchConsoleProvider` is the
only place credentials are read, and it authenticates with a service-account
key exchanged for a short-lived access token. `lib/search-console` consumes the
interface and never Google.

Measurements are stored in `search_console_metrics`, keyed on property, day,
dimension, page and query. `page_path` and `query` are empty strings where the
dimension does not use them, so the natural key is a plain unique index instead
of one over nullable columns — which would have let the same measurement be
stored twice. `ctr` is a generated column, so it cannot disagree with the two
counts behind it; `position` is stored as reported, because an
impression-weighted average cannot be recomputed from anything else stored.

**The shop works without it, and says so.** With nothing configured, every
entry point answers "Search Console not connected", the sync refuses with an
explanation and writes nothing, and the opportunity engine returns an empty
report rather than a screen of zeroes. A zero is a measurement; there are no
measurements. Nothing in SeoPulse, SearchPulse, the storefront or the knowledge
base depends on it.

**Search Console data is not knowledge.** It is `PROVIDER_RESTRICTED` internal
analytics about this shop's own pages: never exportable (invariant I-10), never
evidence for a product fact (I-1), and carrying no customer identifier (I-9). A
schema test asserts the table has no column that could hold one.

## D-097 — Opportunities are rules over stored measurements, benchmarked against this site's own pages

**Decision.** `lib/search-console/opportunities.ts` computes five kinds from
the stored rows — a page shown often and clicked rarely for where it ranks, a
query a page is shown for but never says, a page ranking just off the first
page, a measurable fall, and a measurable rise — each with the numbers behind
it and a recommendation in words. The thresholds are one exported constant, so
any figure on a screen can be explained.

**The benchmark is this site's own median click-through rate per position
band**, not a published industry table. A table would be someone else's data
presented as this shop's measurement. A band with fewer than five pages carrying
enough impressions produces no benchmark at all, and that is reported as
insufficient data rather than compared against anyway.

**No score, and no figures this shop cannot measure.** Search volume, keyword
difficulty, CPC, backlinks, competitor traffic and competitor keyword counts
are not measurements Manifest has; they are absent rather than estimated. A
test asserts none of those words appears in a report.

**Opportunities are recomputed, decisions are stored.** A derived list in a
table has to be kept in step with the data it came from, and a stale row reports
work that is no longer there. What is stored is `seo_opportunity_decisions`: a
person acted, dismissed or is watching, with the measurements as they stood.
The finding is still computed from the rows every time; the decision is a note
on it.

## D-098 — One SEO change history, widened rather than duplicated

**Decision.** Section 4.4 of the platform tracker planned a `seo_change_history`
table. Stage 4 had already built `seo_field_history` with exactly those columns
for listings. Migration 0037 widens that table — an entity type, a category, and
the workflow that made the change — instead of adding a second store of the same
kind of record, which is the mistake this programme keeps closing elsewhere.

Shelves now have SEO history for the first time: `updateCategory` records
before and after for its five SEO fields and its intro copy. A shelf row records
no per-field state, because a shelf has no state machine behind it, and claiming
one would be inventing a store that does not exist.

The table stays append-only in the database. A correction is a new row.

## D-099 — Before and after is an observation, never a cause

**Decision.** `compareAroundChange` takes one row of the change history and
compares the measurements in the window before it with the window after it. The
change day itself is in neither window: on that day the page was both things.
The output states what the numbers did — "clicks increased in the observed
period after the change" — and carries a `causation` field whose only value is
"not established", beside the list of things that also move these numbers.

**Why the wording is not a matter of taste.** A page's clicks move with the
season, with stock, with price, with what competitors publish and with whatever
Google changed that week. A shop that reads "this change caused traffic to rise"
starts making changes for reasons it has not measured. A test asserts no
comparison ever contains a causal claim.

Where there is not enough to say — a change too recent for a window after it,
a window whose days are mostly unmeasured, or too few impressions either side —
the verdict says which, and no difference is reported.

## D-100 — Controlled learning: Search Console may recommend, never teach

**Decision.** Manifest improves its recommendations by reading what it already
has: approved knowledge, approved sources and aliases, decisions staff made, its
own search log, Search Console performance and the SEO change history. Nothing
retrains, and nothing changes what the shop believes.

**A Search Console query never becomes a product fact, an attribute, an alias
or SEO copy on its own.** It can produce a recommendation on a screen and
nothing else. Turning one into vocabulary is the two-step path D-094 already
established — a person creates a *suggested* alias, and `search.manage` approves
it — and turning one into copy is a person editing the listing. What people type
into Google is evidence of what they want; it is not evidence of what a product
is. The guardrails are printed on the screen that shows the recommendations, and
a test asserts that generating them creates no alias and no fact.

**Reading Search Console needs `catalog.manage`, not `analytics.view`.** Section
4.11 of the platform tracker had planned `analytics.view`. The people who act on
this are the catalogue staff — `product_manager` holds `catalog.manage` and not
`analytics.view` — and what is shown is this shop's own pages rather than
customer behaviour. Requiring the permission that matches the work is narrower
in practice than requiring the one that also opens revenue and funnels.
*Superseded by D-101 in Stage 7: reading is its own permission.*

## D-101 — Reading search performance is its own permission, separate from changing the catalogue

**Decision (owner, start of Stage 7).** Viewing Search Console and SEO
performance is separated from the authority to change the catalogue. A new
read-only permission `seo.view` gates every report; every *action* on those
screens keeps the management permission it already had.

| Operation | Permission |
| --- | --- |
| `searchConsoleStatus`, `opportunityReport`, `changeComparisons`, `learningSignals`, `listingSearchPerformance`, `recentSeoChanges`, `seoChangesFor` | `seo.view` |
| `requestSearchConsoleSync` with `trigger: "manual"` | `catalog.manage` |
| `decideOpportunity` | `catalog.manage` |
| Editing a listing's or shelf's SEO fields, locks, audits, SEO Health | `catalog.manage` (unchanged) |

**Why not `analytics.view`, which the owner named first.** The instruction was
to stop using `catalog.manage` as the semantic permission for an analytics
read, and to fall back to "the smallest clean permission architecture" if
`analytics.view` turned out to be broader than intended. It is:
`analytics.view` gates `lib/admin/analytics.ts` and `lib/admin/insights.ts`
— the purchase funnel, order and signup trends, best sellers, shelf
performance, and customer insights such as repeat-buyer counts and the share of
orders placed by an account. Granting it to `product_manager` in order to show
them how their pages rank in Google would also have opened commerce and
customer-behaviour analytics, which is exactly the unintentional widening the
instruction warned against. It would also have handed SEO performance to
`finance`, which has no use for it.

So `seo.view` is the narrow permission, and it follows the existing
`area.action` naming and the existing rule that a role is a named list of
capabilities (D-034). Granted to `super_admin`, `staff_admin`,
`product_manager` and `marketing`. The first three already reached these
screens through `catalog.manage`, so for them nothing opens and nothing
closes; `marketing` gains the reports, which is the point of separating a
read from a write, and gains no ability to change anything.

**The screen shows what the permission allows.** `/admin/seo-performance`
loads under `seo.view` and passes `canManage` into the panel, so a read-only
viewer sees every measurement, every finding and the whole change history, and
no "Sync now" or decision buttons. That is presentation only — the two API
routes still resolve the session and the `lib/` functions still call
`requirePermission(actor, "catalog.manage")`, so a forged request from a
read-only account is refused (CLAUDE.md section 7).

**What stayed on `catalog.manage`.** The SEO Health Center, a listing's page
audit and SEO field editing are catalogue tooling, not performance reporting:
they exist to change listings, and the people who read them are the people who
fix them. Widening those was not asked for and would have been scope creep.

---

## D-102 — A bulk import declares itself, and its reindexing waits for the worker

**Decision (Stage 7, on measurement).** Accepting a fact or approving an alias
queues the listing for reindexing through row-level triggers (Stage 5). Those
triggers are right, but they were paying for the rebuild at the wrong time: on
the 5,000-listing scale database the knowledge backfill went from 176 s before
the triggers existed to 305 s with them, and only about 30 s of that was the
queue upserts themselves. The rest was each listing's search index being rebuilt
at the commit of its own sync and thrown away when the next listing was synced.

A transaction may now say which kind of write it is (migration 0040). The
default — no setting — is the staff one: a claim accepted in the admin still
rebuilds at that commit, because a shopper searching a second later should find
the new words. A bulk import sets `manifest.search_queue_source = 'rebuild'`
with `set local`, and the same triggers queue the listing for the background
worker instead. The backfill then takes 181 s and leaves 5,000 listings queued.

`set local` is the safety argument rather than a convenience: the value cannot
outlive its transaction, so an import that crashes halfway cannot leave the shop
quietly not reindexing. A listing already queued as a staff change is never
downgraded into the import's backlog, and `npm run pkb:backfill` reports how
many listings are waiting, so an import never implies the index is current when
it is not.

---

## D-103 — A legacy column is contracted on measured coverage, never on the plan that expected it

**Decision (Stage 7).** The plan for the knowledge platform said Stage 7 would
contract `category_attributes`, the legacy option readers and the specification
readers. It does not, because the database says they are not ready:

| Legacy system | Coverage on the development database |
| --- | --- |
| Shelf specification definitions | 2 of 2 covered — contractable |
| Variant option groups | 2 of 5 covered — 3 unmatched |
| Variant option selections | 6 of 8 mirrored — 2 unmirrored |
| Listing search terms | Retained on purpose (D-105) |

with 72 values parked, waiting for somebody to say what they are.

Contracting today would drop values that have no knowledge attribute behind
them, which is the one failure the whole staged migration exists to avoid. So
`legacyCoverage` counts each system from the database and shows it on the
knowledge screen, `allCovered` is the gate a later contraction has to ask, and
the decision to remove a column becomes a reading rather than an opinion. This
is invariant I-12 kept honestly: the readers stay until a report says nothing
reads what is not mirrored.

---

## D-104 — An address is judged after it is expanded, and an address that cannot be parsed is refused

**Decision (Stage 7, from two defects).** The SSRF check for outward retrieval
used to match how an address was spelled. `::127.0.0.1`, the deprecated
IPv4-compatible form, was treated as public and could reach loopback;
`::169.254.169.254` could reach the cloud metadata endpoint the same way. The
opposite mistake was there too: `::ffff:8.8.8.8` was refused because every
mapped address was refused whatever it wrapped, which would shut out a
manufacturer's site reachable only that way.

An IPv6 address is now expanded to its eight groups before any rule is applied,
so `::ffff:127.0.0.1`, `::ffff:7f00:1` and `0:0:0:0:0:ffff:127.0.0.1` are one
address with three spellings; an embedded IPv4 address, mapped or compatible, is
judged by the IPv4 rules; a zone index, which names a local interface, is
refused; and anything that cannot be parsed is refused rather than assumed
public. The general rule for any future check of this kind: decide on the
address, never on its text, and treat unparseable as hostile.

---

## D-105 — Search terms are retained by decision, and offered as suggestions rather than converted

**Decision (Stage 7).** `products.search_keywords` is kept. It is not kept
because it could not be migrated.

A search term is a listing's marketing hint: staff-authored, fed to the shop's
own search, counted by SEO readiness, proposed by SeoPulse. An alias is a claim
about a product's identity, approved through a workflow. Converting the first
into the second wholesale would turn unapproved text into approved vocabulary,
which D-094 and A-7 forbid, and deleting it would throw away search knowledge
nothing else holds.

What Stage 7 adds is the path out, one decision at a time:
`suggestAliasesFromKeywords` offers a listing's terms as *suggested* product
aliases, attributed to whoever asked, and approving each one still needs
`search.manage`. Nothing is deleted, a rejected term is never re-proposed, and
running it twice proposes nothing new. The report says what each term has become
— an approved alias, waiting for a decision, or a search term only.

A test asserts the part most likely to be acted on wrongly: the search-terms
column is never reported as contractable, not even on a database where every
term has been approved as an alias.

---

## D-106 — A foreign key is indexed where a delete would scan it, not everywhere

**Decision (Stage 7, on measurement).** Stages 2 to 6 added 75 foreign keys with
no index on their own columns, and 22 of those fire on a parent delete. Indexing
all of them would be tidying that looks like hardening: most are attribution
columns on small tables whose parents are never deleted, and every index is a
cost on every write.

Migration 0041 adds the five that are on a real delete path *and* on tables that
grow with traffic or knowledge rather than with the catalogue, so that an
unindexed scan gets slower for ever: the two `search_events` and `search_clicks`
cascades behind `deleteProduct`, the two `seo_research_runs` set-nulls behind it,
and `pkb_product_sources` behind `releaseListingKnowledge`. Measured with 500,000
`search_events` rows, deleting one listing's events took 41.0 ms on a sequential
scan and 0.6 ms on the index; the scan is linear, so at five million events it is
about four hundred milliseconds inside the transaction that deletes a listing.
The migration records why the other seventeen are left alone, and
`search_console_metrics.last_sync_id` is deliberately excluded because nothing
deletes a sync row today.

---

## D-107 — The page aggregate counts rows and multiplies in float8, with the shape it relies on asserted

**Decision (Stage 7, closing R-16).** `pagePerformance` is the opportunity
engine's most expensive read, and at 20,000 pages the report took 4,867 ms, of
which 4,422 ms was two calls to it. Neither cost was the scan of the window.

Two changes bring the same report to 737 ms with identical output. A page's days
with data are counted as rows rather than as `count(distinct measured_on)`,
because a per-group `count(distinct …)` cannot be aggregated in parallel and
sorts every group. And `position`, which is `numeric`, is multiplied in `float8`,
because the per-row numeric multiplication cost more than reading the rows —
896 ms against 154 ms on its own. The weighted average only ever becomes a
JavaScript number, so nothing is stored or compared in the lower precision.

Counting rows is only correct while a page has at most one row per day. That
holds because a page row carries no query and
`search_console_metrics_unique` covers
(property, measured_on, dimension, page_path, query) — so the assumption is
asserted by a test that syncs the same day twice, with searches for the same
page, and expects one row. An optimisation that depends on a stored shape is
only allowed here with a test that fails when the shape changes.

---

## D-108 — A missing address stays a soft 404 for now, and the reason is written down

**Decision (Stage 7, from the first production run of the end-to-end suite).**
A listing or shelf address with nothing behind it answers `200` with
`<meta name="robots" content="noindex">` rather than `404`. That is left as it is
in this stage, deliberately.

**Why it happens.** Cache Components (D-054) prerender a static shell for every
dynamic route and stream the rest. The status has to be committed before the
first byte, which is before `cachedProductContent(slug)` has answered, so by the
time `notFound()` fires the response is already a 200 and Next injects the
noindex tag instead of a status it can no longer change. Next's own guidance says
the same: to get a real status the existence check has to happen before the
response streams, which means in `proxy` or in a config redirect.

**Why it is not fixed here.** `proxy.ts` deliberately reaches neither the
database nor any application module — every check there is decided from the
request alone, and it is the outer layer of a check that is also made where it
counts. Putting a slug lookup in it would add a database round trip to the two
hottest storefront routes, on a layer that on a serverless platform runs as its
own function with its own connections. That is a real cost against a real but
small benefit: the not-found page still renders, the page is unindexable, and
Google drops a noindex page from its index. A crawler spends a little budget on
addresses that do not exist and an uptime check counts a 200 where a 404 would be
more honest.

**What was done instead.** The end-to-end test that asserted `404` — written
before Cache Components and never run against a production build until now —
asserts what is actually guaranteed: the shop's own not-found page, and the
noindex tag. The behaviour is recorded as finding F17 and risk R-18, to be
reconsidered in Stage 8, where deployment behaviour is the subject. A check in
`proxy` is the known fix, not an open question.

---

## D-109 — Parked legacy values are classified, never discarded and never guessed

**Decision (Stage 8).** `pkb_unmapped_values` holds every legacy value the
knowledge pipeline refused to place, because placing it would have meant
deciding what a written label means (A-8). Stage 7 reported the count — "72
values parked" — and a count is not something anybody can act on. It invites the
two wrong actions: throwing the values away because nothing reads them, or
placing them by hand in the database because there are only seventy-two.

`classifyParkedValues` says what each one *is*, from the database, in five
classes decided in this order:

| Class | What it means |
| --- | --- |
| `unusable` | Not a value anything can hold: an identifier that failed its check digit (kept exactly as supplied and never corrected, R-6), or an empty value. |
| `obsolete` | The listing behind it is archived or has no knowledge record. Kept for history; there is nothing to migrate into. |
| `already_represented` | An approved attribute answers to this label *and* the slot it would fill already holds a value. The parked row duplicates what is stored. |
| `migratable` | An approved attribute answers to this label — by its own label, its key, an approved alias, or an approved mapping — and the slot is empty. |
| `ambiguous` | No approved attribute answers to this label, or more than one does. It needs a person. |

The report is read-only and it never invents a meaning: a value is called
`migratable` only when the knowledge base *already* holds an attribute that
answers to its label. Migrating one is still the existing workflow —
`decideLabelMapping`, which queues the listing so the value is placed by the
normal pipeline with its provenance intact — so nothing is ever edited in place.

**On this repository's development database, all seventy-two are accounted for
and none can be migrated without inventing meaning:** 71 `ambiguous` and 1
`unusable` (the seed's UPC with a bad check digit, R-7). The ambiguous ones are
free-text specification labels of the kind a shelf author writes — "Burr",
"Hopper", "Cacao", "Shelf life" — and the canonical vocabulary has 23 approved
attributes, none of which means any of them. Two are variant option values
("Flavor") whose option group has no attribute behind it either.

That is the answer to whether `category_attributes` can be contracted: no, and
not because of the parked values. The three-part proof a contraction needs fails
on each part. `resolveCategoryAttributes` validates every product save;
`/admin/categories`, the product editor and one API route read the definitions;
`refresh_product_search` reads them in SQL to build the search document; and
`createCategoryAttribute`, `updateCategoryAttribute` and
`deleteCategoryAttribute` still write them. The knowledge base covers the *two*
definitions this database has, but variant option groups are covered 2 of 5 and
option selections 6 of 8, so `allCovered` is false. The table stays, the
remainder stays explicit, and the classification is on the knowledge screen so
the next person to look at it is looking at work rather than at a number.

---

## D-110 — A decision is read under its own lock, wherever a decision is recorded

**Decision (Stage 8, from a defect).** Stage 7 fixed the same mistake twice: the
listing save read the row it patched before taking the lock (finding F8), and
the SEO apply checked "this field is empty" against a read made outside its
transaction. `decideAlias` had it a third time. It read the alias row on the
shared connection, checked there that the alias was still only `suggested`, and
then opened a transaction that updated the row by id alone. Two decisions
arriving together both passed the check and both wrote: an approved alias —
which is live search vocabulary — could become rejected, or the other way round,
recorded against whoever committed last, with nothing on the row to say it had
been decided twice.

Proved with real concurrent writes in `tests/knowledge-decision-concurrency.test.ts`,
which fails against the previous code: both decisions were fulfilled.

The row is now read inside the transaction with `for update`, and the update
carries `status = 'suggested'` in its `where` as well, so a caller that finds
another way in still cannot re-decide a decided alias. The general rule, now
that it has cost three fixes: **where a write depends on a row's current state,
the lock comes before the check, and the check is repeated in the write's own
predicate.** Claim decisions already did this — `loadClaimsForDecision` selects
`for update` — and the same test covers them as the control.

---

## D-111 — A prune deletes in bounded batches and counts rows, not identifiers

**Decision (Stage 8, on measurement).** Every prune in the hourly
`maintenance.prune` job was one statement that deleted everything past its
retention window and asked for an identifier back for each row deleted — only
ever to call `.length` on the result. Two unbounded things in one place: a
transaction whose size is decided by how much has accumulated, and an array in
memory the same size.

Measured on the bench database: pruning 500,000 Search Console measurements took
2,177 ms and grew the heap by 106 MB for the identifiers of rows that had just
ceased to exist. The size of that table is decided by Google rather than by this
shop's catalogue (R-17), and the search event tables grow with traffic, so five
million rows is an ordinary amount to find after a gap — about a gigabyte, inside
a job that on a serverless platform has a few hundred megabytes and a time limit.

`pruneInBatches` (`lib/prune.ts`) walks the table instead: each batch is its own
statement, transaction and lock, `ctid` makes the delete a direct fetch rather
than a second pass over the condition, and the loop stops when a batch comes back
short or when it reaches its ceiling — at which point it says `more`, so an
operator knows the next run has work waiting rather than believing the prune
finished. Applied to the five unbounded prunes: search queries, search clicks,
search events, Search Console measurements, rate-limit hits and finished jobs.
Guest carts already batched, which is where the shape came from.

620,000 measurements now prune in 2,397 ms with the live set bounded by one
batch rather than by the number of rows deleted.

---

## D-112 — Product preparation is a durable run that coordinates, and stops where a person decides

**Decision (Stage 9).** A diagnostic of the real Add Product workflow found the
gap between the knowledge platform and the way products are actually created.
The form collected what the shop calls a product — title, category, brand, SKU —
and nothing a manufacturer would recognise. The save synchronised the listing
into the knowledge base but never re-assessed the identity, so a newly created
product stayed UNRESOLVED until somebody opened Product Intelligence and pressed
a button; and because it was UNRESOLVED, nothing could enrich it. Everything
needed to research a product existed, and nothing connected it to the act of
adding one.

Three things follow, and they are separate decisions on purpose.

**Identity is collected on the product save, and stored where it already lives.**
A product save may now carry `identity`: model name, model number, MPN, one trade
identifier (GTIN, UPC, EAN, ISBN or ASIN), and the manufacturer's own page. None
of it is required and nothing about an existing save changes. It is folded into
`products.details` and `products.identifier_type` / `identifier_value` — the
columns the knowledge mirror already reads — so identity typed on the Add Product
form and identity typed on the Product Intelligence screen become the same rows,
with the same provenance, under the same rules. **No second identifier store**
(D-065). The Manifest SKU is deliberately not identity: it is this shop's label
for something it sells, not the manufacturer's name for what it is. A listing
holds one trade identifier because the column does; two different kinds at once
are refused rather than silently resolved, and a number whose check digit does
not hold is refused at the moment somebody can still look at the box.

**Resolution is re-assessed by the mirror, when identity actually changes.**
`syncListingKnowledge` now tracks whether a save touched the brand, the model
name, the generation or any trade identifier, and re-assesses the product's
resolution inside the same transaction when it did. The mirror is the right place
because every path that writes a listing's facts already goes through it, and
because only it knows whether a save changed an identity value or merely rewrote
the same text — a category-attribute change across four hundred listings
re-assesses nothing. The semantics are untouched: VERIFIED is still only ever set
by a person, a confirmed identity whose signals changed still drops back to
re-assessment, AMBIGUOUS is still ambiguous, and nothing here enriches.

**The one-click workflow is a durable run, not a long request.** A
`product_preparation_runs` row (migration 0043) holds the state of one attempt to
take a product from a typed title to a prepared page. It coordinates work that
already exists and repeats none of it: the knowledge sync, the resolution
assessment, `sourceOutlook`, `requestEnrichment`, the review queue, `runSeoPulse`,
the search index and `lib/seo/readiness`. It is a run rather than a request
because enrichment retrieves pages over the network and review waits for a
person: a staff member who starts it and closes the tab must be able to come
back, and a worker that dies half-way must resume at the step it reached.

Idempotency is by record, not by hope. Each step is written to the run when it
has genuinely completed and is never run again, so a retry does not research
twice, propose the same claims twice or generate a second analysis. The
enrichment run's id and the research run's id are kept on the row, so a retry
waits for work it already started. A partial unique index allows one live run per
product, so two people pressing the button produce one run.

**It stops where the existing architecture stops.** An ambiguous identity, a
conflicting claim, a claim nobody has accepted, a label no attribute names and a
product with too little established fact each halt the run in NEEDS_REVIEW or
BLOCKED, with a code, a sentence and a remedy. It does not confirm an identity,
accept a claim, approve a domain or apply generated wording. Auto-accepting to
reach a one-click finish is precisely what the verification architecture exists
to prevent (D-072, D-074, D-076), and convenience is not a reason to weaken it.

Permissions are the existing ones exactly: preparing a product asks for
`catalog.manage`, and every trust decision — a source domain, a verification
policy — continues to ask for `knowledge.manage` in `lib/pkb`. The worker acts as
the staff member who asked for the run, whose permission is checked again by each
function it calls, rather than being given a way past those checks.

---

## D-113 — SEO Pulse is given the knowledge base's established facts, read-only

**Decision (Stage 9, from the same diagnostic.)** `loadPulseInput` read the
listing's own columns and nothing else. Everything the enrichment pipeline had
established — a verified GTIN, a material accepted from the manufacturer's
documentation, a measurement taken from a specification sheet — was invisible to
the generator whose job is to describe the product. The listing's columns and the
knowledge base agree for values staff typed, because the mirror keeps them in
step (D-070), but nothing accepted through review is in a legacy column at all.

`SeoPulseInput` now carries `knowledge`, read through `groundedKnowledge` in
`lib/pkb/publish.ts` — beside `publishableKnowledge`, under the same rule and in
the same file, because it is the same question asked more widely. A value appears
only when its state is VERIFIED or MANUAL (invariant I-11): a suggested claim, a
conflicting one and a legacy value of unknown origin are all absent, so **an
unreviewed claim cannot become a factual generation context**. The specification
and measurement tables append it last, after the listing's own rows, so a value
staff typed keeps its row and the knowledge base only adds what the listing does
not carry.

The direction is one-way and stays one-way. Generated prose is not evidence and
never becomes a fact (I-1); preparation generates a run and does not apply it;
and commercial offer data — price, stock, preorder capacity, promotions — is not
in the knowledge base to be read from it (I-8).

---

## D-114 — Automatic source discovery is one optional provider, returning addresses only

**Decision (Stage 9.)** `ProductResearchProvider` had a single implementation
that reported NOT_CONFIGURED. That is a supported state and stays the default
(A-6): the Brand Source Registry, the addresses staff attach and the documents
they provide all work without it. But a shop that wanted automatic discovery had
nowhere to turn it on, and "implement one later" had been the answer since
Stage 2.

`brave` is now a second implementation, selected by `PRODUCT_RESEARCH_PROVIDER`
and needing `BRAVE_SEARCH_API_KEY`. It is a documented JSON endpoint on one
pinned host, not a parsed search page: scraping a search engine's HTML breaks
without warning and is usually against its terms. The query is built from the
product's *identifiers* rather than its name, because a model number either
matches a page or does not, where a name matches a thousand pages about something
else; a product with no identifier is not searched for at all, which is the
product the resolution gate has already stopped.

**A provider returns addresses. It does not return facts.** A title and the
index's own description travel with a candidate so a person can see why it was
offered, and neither is ever treated as a product fact. Every discovered page is
still fetched through `safeFetch`, still checked against robots.txt, still
matched against the product's identifiers, still recorded as evidence and still
proposed as a claim somebody accepts. Being first in a provider's list confers
nothing: official ordering uses only domains the Brand Source Registry already
approves for that brand, and the registry match is checked again per page.

Failure is typed and quiet. A missing key is UNAVAILABLE, a quota or an outage is
UNAVAILABLE, an unreadable answer is FAILED, and in each case the run carries on
with the sources it already has. No provider answer can write anything, so no
provider failure can corrupt a product.

---

## D-115 — Too little to say is reported, not filled with something true about the shop

**Decision (Stage 9.)** With an empty listing the rules generator writes
"<product> is part of our Headphones range and is sourced from the United States
and delivered across Bangladesh." Every word is true and none of it is about the
product. The sentence is a reasonable fallback; the fault is reporting the result
as a researched product listing when no product fact went into it.

`knowledgeSufficiency` counts what is actually established about the product —
brand, an identifier, specifications, measurements, key features, box contents, a
description of some substance — and says whether there is enough to write from.
The category, the title, the price and the delivery terms deliberately do not
count: every listing has them.

The verdict changes reporting, not generation. A thin run is still generated and
still available to apply by hand, because a staff member who wants the fallback
should have it. Product preparation reads the verdict and stops at NEEDS_REVIEW
with what is missing, rather than reporting the product READY. **Nothing is
invented to clear the bar** — the answer to too little knowledge is more
knowledge, which is what the rest of the pipeline is for.

## D-116 — The staff product-entry screen translates preparation; it never re-decides it

**Decision (Stage 10.)** Stage 9 left a durable, honest preparation backend and
no way for a normal employee to use it. The vocabulary it reports in —
`PREPARING_SEARCH`, `AUTOMATIC_SOURCE_DISCOVERY_NOT_CONFIGURED`, a remedy that
assumes the reader knows what the Brand Source Registry is — is correct and
internal. The product-entry screen is a translation of it, and nothing more.

`lib/preparation/presentation.ts` is that translation, and it is a pure module
with no database access, so the mapping is unit-tested rather than only
observed in a browser. Three rules hold it:

**Nothing is shown as finished unless the run recorded it finishing.** The
checklist is built from `steps`, which the orchestrator writes only when a step
genuinely completes. A `degraded` or `skipped` step reads as done-with-limits,
not as done. There is no percentage and no animation standing in for progress,
because a fabricated bar is exactly the thing that makes a real delay look like
a hang.

**Every issue on screen is a note the backend returned.** The heading and the
buttons are chosen here; the message and the remedy are the backend's own
words. A code this module has never heard of still renders, with those words
and a retry — the alternative, hiding it, would leave a staff member looking at
a stopped run with no explanation.

**Which service does automatic discovery is not staff information.** They are
told whether it is available. The provider's name and configuration stay on the
administrator's screens (D-114).

The screen decides nothing the backend decides. It cannot confirm an identity,
accept a claim, approve a domain or apply generated wording: those go to
Product Intelligence under their own permissions, and preparation continues
through the existing `continue` action once they are settled. Preparing a
product remains `catalog.manage`, checked server-side on every route; a simpler
interface does not widen access.

**Add Product asks for the product, not for a catalogue record.** Name, brand
and category, then optionally the manufacturer's model, part number, barcode
and page. The description, key points and SEO fields it used to ask for are
what SeoPulse now writes, and asking a person for them before anything is known
was asking them to do the work twice. The Manifest SKU stays on the form and
stays visually apart from the manufacturer's numbers, because staff were typing
one where the other belonged.

**Both paths out of the screen are real.** "Research & Prepare with SeoPulse"
creates the product and starts a run in one movement; "Save without SeoPulse"
creates the same product and stops, which is the only sensible path for a
private-label or locally sourced product no manufacturer's page describes.
Removing the manual path would have made the shop unable to sell things it
sells.

## D-117 — Intelligence is one admin destination over five unchanged systems

**Decision (Stage 11.)** Manifest had grown five separate top-level admin
destinations — Search, SEO Pulse, SEO health, Search performance and
Knowledge — over systems that all answer one question: what does this
catalogue need me to do about how it is understood and found? Five entries out
of sixteen in the admin navigation, each with its own heading style, its own
card border and its own table, is how a platform starts to read as a pile of
screens rather than a product.

They are now the tabs of `/admin/intelligence`: Overview, SeoPulse, Product
Knowledge, SearchPulse, SEO Health, Search Console, Sources & Policies. The
main navigation carries one entry, Intelligence.

**Nothing underneath moved.** SeoPulse, the Product Knowledge Base, product
preparation, SearchPulse, the SEO audit and Search Console each still own their
own data, their own permissions and their own API routes. No table, no policy
system, no registry and no audit engine was duplicated or rewritten. The
workspace is a reading of what those systems already return.

**Tabs are routes, not state.** Each tab is a real page under
`app/admin/intelligence`, so the selected tab is in the address bar, a refresh
keeps it, the browser's back and forward buttons work, and a link with a filter
on it opens the right tab already filtered. Next's client router does the
navigation, so moving between tabs does not reload the page. No custom router
and no state-management framework was introduced: a deep link is a query
parameter, validated by a guard in `app/admin/intelligence/filters.ts`, and an
unrecognised value opens the tab unfiltered rather than failing.

**The old addresses still answer, with the same component.** `/admin/search`,
`/admin/seo-pulse`, `/admin/seo-health`, `/admin/seo-performance` and
`/admin/knowledge` render exactly the panel their tab renders, with a line
saying where the screen now lives. They were not redirected, because a redirect
would have thrown away `?days=90` and the tests and bookmarks that use them,
and they were not copied, because two implementations of one screen drift.

**The overview answers "what needs my attention", and every count is a link.**
Each figure is a count returned by the system that owns the thing counted —
preparation stages from `lib/preparation`, knowledge counts from one aggregate
over the knowledge tables, SEO findings from the deterministic audit, search
figures from recorded searches, Search Console figures from stored
measurements. Nothing is invented to fill a card. A metric that has a list
behind it is a link to the tab that lists it, already filtered; a metric that
cannot be derived is not shown at all. There is still no aggregate SEO score
(D-095): a single figure would invite arguing with the number instead of fixing
the listings.

**One destination is not one permission.** A tab is offered only to a role that
holds a permission opening it, and every tab's page checks the same permission
with `requireAdminPage`, and every function it calls in `lib/` checks it again.
A role that can open no tab is not offered Intelligence at all and is redirected
if it types the address. Nothing was widened: marketing still sees SearchPulse
and Search Console and no catalogue tab; approving a source, a policy or a label
mapping still needs `knowledge.manage`, and a reader without it sees the rules
and no buttons.

**Background Work stays its own destination.** It runs platform-wide jobs —
notification delivery, order expiry, media sweeps, prunes — not only
intelligence ones. The overview shows a single indicator when an intelligence
job has given up after its retries, and links to the job screen rather than
absorbing it.

**Product Intelligence stays its own screen.** `/admin/products/[productId]/intelligence`
is the advanced drill-down for one product, reached from that product's editor.
The workspace is the catalogue-wide surface. They answer different questions and
neither replaces the other.

## D-118 — A manufacturer's page is read the way manufacturers write one

Three real products — an Apple iPhone 11 Pro Max, a Sony WH-1000XM6 and an
Anker Prime Power Bank — were put through Add Product → Research & Prepare with
SeoPulse against the manufacturers' own pages. Every one of them produced
nothing. The reasons were not judgement calls; they were defects, and the
decisions taken to fix them are these.

**A specification table is not a `<table>` any more.** The extractor read
`<table>` rows, `<dl>` pairs, schema.org JSON-LD and "Label: value" text lines.
Apple publishes a heading and a list, Sony's Help Guide publishes a heading and
paragraphs, Anker publishes a two-element layout row from a CSS grid. All three
are now read, structurally: a heading and the block beneath it, and an element
whose only two children are text. Neither rule knows anything about a brand or a
product family. Two rules keep the noise down — a block whose text is mostly
link text is navigation, and a line inside a block that is itself "Label: value"
is read as its own pair — and everything either rule produces is still a
proposal that an attribute must name or a person must classify.

**A page carries the name it gives itself.** A document's name was only ever
read out of JSON-LD, so a page without JSON-LD had no name, and the identity
check had nothing to compare. The `<title>` and the first `<h1>` are now
recorded as names. They are compared, not trusted.

**The Brand Source Registry can vouch for a brand the page never prints.**
Apple's specification page and Sony's Help Guide name the model everywhere and
the brand nowhere, so `identityVerdict` returned `unknown` and the run proposed
nothing. When a page comes from a domain somebody with `knowledge.manage`
approved *for one of this product's own brands*, that approval now stands in for
the brand word. Nothing else is relaxed: the model must still appear in what the
document calls itself, and a page naming a different brand is still a mismatch.

**An approved registry role decides what kind of source a page is.** A page
staff paste arrives as `public_web`, because that is all an address is. Recorded
that way it could never satisfy `official_manufacturer_documentation`, so
nothing a run read could ever become established knowledge — which is why the
first manual test stopped at INSUFFICIENT_KNOWLEDGE every time. A retrieved page
is now recorded under the source type its approved registry role implies. The
trust is still the registry's decision; only its consequence was missing.

**Identity is not knowledge about a product.** `knowledgeSufficiency` counted
the specification table's rows, and that table restates the brand, the model
name, the model number and the trade identifier. A listing carrying nothing but
"Sony / WH-1000XM6" reached four facts and was called researched. Identity is
now counted once, where it always was, and never again as a specification.

**A researched product's description is about the product.** The rules
generator had no features to offer beyond what staff had typed, so a researched
product still got "is part of our Electronics range and sourced from the United
States". It now writes key features from the facts that were established —
verbatim, one recorded fact per line, nothing reworded into a claim — and the
sourcing and delivery terms moved to the buying paragraph where they belong.

**The Specifications section shows what is already known.** The facts live in
the knowledge base and the product page reads them from there, which left the
staff editor unable to show them at all (D-113). It now lists them, read-only,
with a link to Product Intelligence. Nothing is stored twice.

**What is read but not used says so.** A page whose identity signals do not
settle which product it is for proposes nothing, by design. Preparation used to
report "read 1 document, proposed 0 values" and then complain about insufficient
knowledge. The verdict is now reported in the step that produced it, with the
two things a staff member can do about it.

## D-119 — A manufacturer's shop page, a database that cannot store it, and filler that looked like research

A Glorious Model O was prepared against gloriousgaming.com, the manufacturer's
own Shopify store. The page was fetched, and the run stored nothing: the local
database was WIN1252, the page carried U+200B zero-width spaces, and the insert
failed — five times, each attempt fetching the page again, with a job error that
kept the start of Drizzle's INSERT and lost PostgreSQL's reason. Behind that
failure were several more, and the decisions taken to fix them are these.

**Invisible storage noise is removed; nothing visible is.** A short, named list
of characters — NUL and the other C0 controls except tab and line breaks, U+200B,
U+2060, U+FEFF, the soft hyphen, the invisible maths operators, the deprecated
format controls and the interlinear anchors — is removed from every stored value,
from visible text, and from parsed JSON-LD (where `​` escapes only exist
after parsing). Not the whole Unicode `Cf` category: the zero-width joiner holds
emoji together, the non-joiner shapes Persian and Indic scripts, and the
bidirectional marks decide reading order. Nothing is transliterated.

**The database has to be UTF-8, and Manifest says so rather than fixing it.**
`db/encoding.ts` names a non-UTF-8 database with the exact commands to create a
UTF-8 one; `db:server`, `db:setup`, `db:migrate` and the server's startup all
report it. A new embedded cluster is initialised `--encoding=UTF8 --locale=C`.
Nothing recreates or converts an existing database — it holds someone's
catalogue.

**A failure that cannot change is not retried.** The job runner dead-letters a
job at once when the database error's SQLSTATE describes the data or the
statement (encoding 22021/22P05, value too long or malformed, NOT NULL, CHECK,
undefined column or table). Unique and foreign-key violations, deadlocks,
serialisation failures and connection failures are all still retried.

**The job keeps PostgreSQL's reason, not the statement.** `describeDatabaseError`
records the SQLSTATE, message, detail, table and constraint and the first words
of the statement, bounded, never the bound values and never a stack trace. It is
what the background-jobs screen (administrators) shows. An enrichment run that
failed while storing a page records `source_storage:` or
`source_storage_encoding:` ahead of that, and preparation tells staff only "We
read the product page but could not store the retrieved information", with a
remedy pointing an administrator at Background work. The run is forgotten so a
retry researches afresh.

**Identifiers on the Offer count.** Shopify and most shop platforms put the SKU
and GTIN on each Offer, one per colour, not on the Product. Offers are read —
including inside an AggregateOffer — only from the Product that declares them,
and kept with it. A SKU with a letter in it is compared as a model identifier
(a manufacturer's own code, "GLO-OC-WL-BLK"); an all-digit SKU, which is almost
always a retailer's shelf number, is not. Matching standards are unchanged: a
GTIN decides when both sides have one, a model identifier next.

**A page about a different product stops for a person.** When a run's only page
disagrees with the product's identity, preparation asks for review with "The
product page appears to describe a different product", both sides' identifiers
as typed, and the page's address, and offers Correct product identity, Use
another source and Continue manually. The identity is never changed for anyone.

**Feature cards, and less furniture.** A title and the paragraph under it,
beside an icon, is read as a pair — only when exactly two children carry text,
both plain, the second a paragraph longer than the title, nothing to click, not
link text. Navigation, footers, forms, buttons, reviews, newsletters, carts and
related-product blocks are recognised structurally (element, role, or a class or
id word) and never produce pairs or stored text; a dialog, modal or drawer is
deliberately *not* on that list, because full specifications often live in one.
A small block (at most four children and a thousand characters) holding a
"Shop now" or "Add to cart" is an offer, and its headings and cards are dropped
— never its table rows. Calls to action and review scores are never values; a
JSON literal in a data container is never text; a sentence split across two
elements is not a label; the same statement read twice is one pair.

**One list of identity labels.** `lib/pkb/identity-labels.ts` replaced the two
drifting copies in `rules.ts` and `facts.ts`. Part number and MPN can no longer
become key features, and a key-feature line that only restates an identifier
does not count towards knowledge sufficiency. The four-fact threshold is
unchanged.

**No customer content without knowledge.** Fill with SeoPulse writes the
description and key features only when knowledge is sufficient; otherwise it
says "SeoPulse needs more verified product information before it can prepare
customer content" and leaves them as they are. Search wording from the name may
still be filled. The rules generator writes no description at all when knowledge
is insufficient, and opens on a fact about the product when it is — never "<Product>
is part of our Electronics range".

**Buying terms are not part of the description.** The "Buying it here" block —
preorder status, arrival, landed price, delivery, warranty — was frozen into the
description at generation time and went stale. The product page already shows
all of it from the live offer beside the price (the variant picker and the
journey section), so it is simply no longer written. Existing descriptions that
contain it are left alone; staff content is never rewritten.

**Research state is visible.** The editor and `?preview=1` say "Research
incomplete — SeoPulse still needs product information" or "Product research
ready", from the same sufficiency verdict preparation and Fill use, with
"Continue product preparation" linking back to the editor. Preview is never
blocked, and shoppers never see it.

**A list written as one value is a list.** Glorious writes what is in the box
as one table cell: "• 1× USB Receiver • 1× Ascended USB-A to USB-C Cable • 1×
USB-A to USB-C Adapter". It was proposed, accepted and shown as a single
"In the box" item. For an attribute whose cardinality is `multiple`, research
now splits such a value into items and proposes one claim per item, each in
its own ordinal slot. It splits only on bullet glyphs and line breaks — never
on commas or middle dots, which sit inside items as often as between them. A
value with one item is proposed as itself, less any leading bullet. Facts
already accepted as one run-on item are not rewritten; the next research run
proposes the items, and they conflict with the old value for a person to
decide.

## D-120 — Generate, regenerate, and whose words are whose

SeoPulse wrote Case B's description (the Glorious Model O Classic Wireless)
before D-119 fixed the generator. Nobody edited it. Fill with SeoPulse
correctly refused to replace it, because Fill never replaces a field that
holds something. The broken sentence would have stayed forever unless someone
retyped it. The rule is right. What was missing was a way to tell SeoPulse's
own unedited wording from a person's.

**Ownership comes from the history, not the state.** An applied recommendation
is MANUAL, exactly like a typed one (D-077). A state cannot separate "SeoPulse
wrote this" from "a person wrote this". The append-only `seo_field_history`
can. Its latest row for a field names the workflow that wrote it
(`seo_pulse_apply`/`seo_pulse_fill` or `editor`). Its after-value says whether
the field still holds that value. `contentOwnership` in `lib/seo/fields.ts`
answers `empty`, `seo_pulse`, `staff` or `locked`. A value the history does not
account for (an import, a direct write, an older listing) is `staff`, the safe
answer. Saving a section without changing a field records nothing, so it
does not take the field over. No migration.

**What each owner is offered.**

- **Empty:** "Use SeoPulse version".
- **SeoPulse's own:** "Regenerate with SeoPulse", one click.
- **Staff's:** "Keep current", "Review SeoPulse version", and "Replace with
  SeoPulse version". Replace appears only once the version is open, and it
  asks for confirmation.
- **Locked:** nothing is offered.

`regenerateWithSeoPulse` takes field names only. It reads the wording from the
run on the server. It refuses a run older than the latest completed one. It
refuses staff-owned fields without `replaceStaff`, and refuses locked fields
always. It checks ownership again inside the apply transaction, after the
listing lock (a new `guard` hook on `applySeoPulse`), so an edit saved a moment
earlier is never replaced by a click made against the older value. The history
records the replacement with reason "Regenerated with SEO Pulse" or "Replaced
with the SEO Pulse version by staff".

**Recommendations are shown where the field is.** Product content and SEO &
search each open with the latest research's version of their fields, when it
differs from what the field holds. "Refresh recommendations" asks for fresh
research. Preparation still only prepares, and Fill still fills only empty
fields; Fill now also names kept fields that have a newer version. Tags,
search terms, photo descriptions and synonyms keep their own apply rules.
Verified specifications are not generated copy. They reach the listing from
the knowledge base as before.

**SeoPulse's own words are not evidence.** `SeoPulseInput.pulseWritten`
marks the description and key features that SeoPulse wrote and nobody
changed. The generator does not treat such features as staff-written, so
regeneration builds from the knowledge base, not from the previous version's
wording (which is how "Size: Standard" kept coming back). Sufficiency does not
count them: a generated listing cannot vouch for itself. Readiness checks
still read the real description.

**Three wording defects found in Case B's regeneration.**

- Box contents appeared as a specification row, and so as a key feature, and
  only its first item: "What's in the box: 1× USB receiver". Box contents
  have their own list. They are no longer a specification row.
- A named size produced "It comes in Standard.". Only a measured size ("42 mm")
  is now said in the opening.
- Grounded key features listed measurements first, so the description opened
  on "Size: Standard". Specifications now come before measurements. The
  warranty is left out of key features: it is an assurance term with its own
  section.

**Known limitation — list slots and out-of-order review.** A list attribute's
items are separate ordinal slots. If staff accept item 3 before item 2, the
listing mirror compacts the list, and item 3 moves into slot 2. Item 2's claim
then collides with it, and accepting it would replace item 3. The
knowledge-to-listing round trip keeps no gaps. This predates D-119. It needs a
PKB change and was not made here. Accepting in list order avoids it.

## D-121 — The local scheduler starts with the web server, and a run says when nothing is picking it up

A Revlon Colorsilk preparation run (`ad1498a0`) sat at "Identifying product —
Preparing…" for 14.7 minutes. Its first `catalog.prepare_product` job was
queued at 15:38:09 UTC. Nothing claimed it until 15:52:52, when a
`jobs:dev` scheduler was started by hand. Nothing had been calling
`/api/cron/jobs` on the development machine. It was the same condition as
the Glorious run. Background jobs run only when something calls the trigger,
and locally that was a second command people forgot.

**One development command.** `npm run dev` is now `scripts/dev.mjs`. It starts
`next dev`, waits until the server answers, and then starts exactly one
`scripts/jobs/dev-scheduler.mjs`, calling that server every 15 seconds. Their
logs are prefixed `[web]` and `[jobs]`. Ctrl+C, or either process stopping,
stops both (the whole process tree on Windows, the process group elsewhere).

- **No new dependency.** The repository had no process runner.
- **No second job system.** The scheduler calls the web server's own
  trigger, the route production uses, so it always drains the database the
  web server uses, and no worker runs inside a request.
- **Duplicates are safe.** A second scheduler started by hand cannot run a
  job twice, because jobs are claimed with SKIP LOCKED.
- **The parts stay available.** `npm run dev:web` (plain `next dev`) and
  `npm run jobs:dev` still work for debugging.
- **The browser tests are unaffected.** They start `dev:web`, because they
  drive jobs themselves and a scheduler would move runs under them.
- **Production is unchanged.** Vercel Cron, the GitHub workflow and the
  trigger route are as they were.

**A run that nothing picks up says so.** The rule uses the existing
heartbeat and the run's own job, with no new timer. A run is "waiting for the
background service" only when all three hold:

1. its preparation job is due and not claimed;
2. it has been due for more than three scheduler intervals (3 minutes at the
   current 1-minute cadence, and never less than 2 minutes);
3. the scheduler has not called in since the job became due.

A job that takes a few seconds is claimed and never qualifies. So is a queue
the scheduler is still working through, because the scheduler keeps calling.

Staff read "Product preparation is waiting for the background service. It
carries on by itself as soon as the service is running." Roles that may open
Background work (`notifications.view`) also read "Background processing
appears to be offline." with a link. Nothing about heartbeats, cron, queues or
job ids is shown. The panel keeps polling, so it moves on by itself when the
scheduler returns, and the waiting state never starts or replaces a run.

**Observed, not changed.** The production `vercel.json` calls `/api/cron/jobs`
once a day, so on a hosted deployment without a per-minute scheduler
(DEPLOYMENT.md) a preparation run would now show this message. That is a true
statement about that deployment.

## D-122 — Prepare with SeoPulse is one action; the sources of truth stay separate

**Decision.** Until now a normal product needed two jobs: "Research & Prepare
with SeoPulse", which stopped once recommendations existed, and then "Fill
with SeoPulse" (or a Use / Regenerate click per field) to put the wording on
the listing. A new employee had to know where research stopped and SeoPulse
started. Product preparation now carries on into the listing itself, so
**"Prepare with SeoPulse" is the normal end-to-end product preparation
action**: Add Product → Prepare with SeoPulse → resolve only what it asks →
add photographs, price and stock → publish.

**The experience is merged; the sources of truth are not.** Research and the
PKB decide what is true; SeoPulse writes wording from what the PKB has
established (D-113); SearchPulse derives the search document. Nothing
generated becomes evidence, no claim is accepted by the run, and no identity
is settled by it. No second orchestration table and no new SeoPulse system:
the existing run (D-112) gained one step.

**One new step, `listing`, between `content` and `search`.** It calls
`applyPreparedContent`, which reads the wording from the stored research run
(never from a caller) and decides per field from ownership (D-120):

- empty → written;
- SeoPulse's own, unedited → refreshed. We chose automatic refresh over a
  per-field "Use updated version" button because every preparation run is
  explicitly requested by a person, nobody's writing is lost (the change
  history keeps the earlier version), and a refresh that left SeoPulse's
  stale wording in place would make "Refresh with SeoPulse" do nothing
  visible;
- staff-written or staff-edited → never written; reported as "kept" and
  offered in the field's section with Keep / Review / Replace;
- locked → never written.

Tags and search terms are only added to, and only when empty or SeoPulse's
own. Ownership is read again inside the apply transaction after the listing
lock; if a person saved a field in between, the step waits and decides again.
Customer content still needs sufficient knowledge (D-115), and wording from an
AI generator is left as a recommendation to read first (finding F2) rather
than written unseen — the rules generator's output is derived from recorded
facts and is written. The write goes through `applySeoPulse`, so validation,
the audit log, the search queue and the field history ("Prepared with
SeoPulse", workflow `seo_pulse_apply`) behave as for any apply. The step is
idempotent by construction: a field it already wrote holds the prepared
wording, so a retry writes nothing. The persisted stage stays
`PREPARING_CONTENT`; no enum changed and there is no migration.

**Continue resumes the same run, from the right point.** `continuePreparation`
now rewinds a stopped run according to what was supplied: identity → from
identification; a new address → from sources (research runs again); a pasted
document (read on the spot) → from verification. Earlier steps stay recorded.
Two keys were needed to make this real rather than nominal:
`requestEnrichment` takes an optional caller key (preparation passes one per
attempt), because its one-minute dedupe window returned the *old* research
run to a Continue made within the minute; and SeoPulse's request key gained
the attempt's tick for the same reason. Within one attempt the tick does not
move, so a retried job still reuses its own research and generation. Retry or
Continue after a failed generation clears the link to it, so the content step
can generate again while the research is kept.

**A re-read value that repeats an accepted value is not a new question.**
Real acceptance found it: preparing the Glorious Model O again re-read the
manufacturer's page and proposed 25 values, all 25 identical to facts a person
had already VERIFIED, and stopped for someone to accept them all again. That
would make every "Refresh with SeoPulse" stop. `createClaim` now records a
claim whose value equals the VERIFIED or MANUAL fact (or identifier) already
in its slot as SUPERSEDED, with a note, no decision time and no decider — it
is not a decision (`pkb_claims_decision_check`). The fact, its state and its
provenance are untouched, and the evidence is kept. A value that differs is
still a CONFLICT; a value repeating a LEGACY or UNVERIFIED fact stays
SUGGESTED, because accepting it is exactly how that fact becomes verified;
and a repeat is left open when another open claim in the slot disagrees.

**The screen.** One progress card; "SeoPulse needs your attention" when it
stops, with only the relevant decision and "Continue with SeoPulse"; on
success a grouped summary (Product / Research / Listing / SEO & search /
Page) built from the recorded steps and what the listing now holds, a count
of recommendations needing a decision, and a separate "Before publishing"
list from the publish checks — because SeoPulse READY is not publish READY.
"Refresh with SeoPulse" prepares again as a new run (only once the previous
one has finished). Intelligence, the report, JSON/CSV and the step details
are under "Advanced details"; the old Fill box is "Manual fill" under
Advanced tools, with its API unchanged. Established identifiers are shown
apart from specifications in the Specifications section.

Permissions are unchanged: preparing and the new apply step ask for
`catalog.manage`, each PKB decision still asks for `knowledge.manage`.

## D-123 — Reading what a manufacturer says in prose, without letting a model say it

**The problem, found on a real product.** "Revlon Colorsilk Hair Color - Black"
stopped at "Research incomplete" with an empty listing, while its SEO fields
held "Revlon Colorsilk Hair Color – Price in Bangladesh" and "Order now,
sourced from the US and delivered across Bangladesh at a fixed landed price."
Three causes, none specific to Revlon:

1. **Identity.** Staff had typed the shade into the model fields: model name
   "Shade 10", model number "(1N)", MPN "10". Those made the identity
   HIGH_CONFIDENCE and then decided nothing: Revlon's page declares no model
   number, only a numeric SKU (not compared) and a ProductGroup of 48 shades.
   The page verdict was `unknown`, so the page proposed nothing.
2. **Reading.** Even when a page is accepted, the structured readers turn prose
   sections (DESCRIPTION, DETAILS, HOW TO USE IT) into one paragraph per
   heading. The facts in them — 100% gray coverage, 25 minutes, up to 8 weeks —
   are sentences, not rows.
3. **Judgement and copy.** Sufficiency was one rule for every product (four
   facts, two of which could be the brand and a code, and "Measurements" always
   asked for). The rules generator's default title and snippet were commerce
   copy, and Fill wrote them on a product nobody had researched.

**What a code can identify (`lib/pkb/identity-labels.ts`).** A model or part
number identifies a product only when it can: `isStrongModelKey` refuses a
value that names a variant dimension ("Shade 10", "Colour: Black", "Size M",
"Pack of 2") and a code of fewer than three letters and digits, or three digits
alone ("10", "(1N)", "010"). Such values are kept exactly as typed and shown
with a note in the identity panel; they never make an identity HIGH_CONFIDENCE,
never match or mismatch a page, and never become search terms.
"GLO-OC-WL-BLK", "WH-1000XM5", "G502", "HP-900" and "GO-WHITE" are unchanged. A
model name that is a variant is shown in Specifications as what it is
("Shade (entered as model): 10") — display only.

**Identity without a code (`identifiedByName`).** A shade of a hair colour or a
flavour of a food is identified by brand, exact name and version. Resolution
accepts that as HIGH_CONFIDENCE, narrowly: one brand, at least three identity
words in the name besides the brand, or two and a recorded version (colour,
size, a model name that is a variant). The existing ambiguity check (same brand
and exact name) still applies. This basis does not vouch for any page:
`identityVerdict` accepts a page for such a product only when the page names the
brand and every identity word of the name, in what the page calls itself or in
the one version it resolves to. The signature a person's confirmation is tied to
includes the name and version for these products only, so no existing
confirmation changed.

**Pages selling several versions.** The extractor reads a ProductGroup's
`hasVariant` (name, distinguishing words, SKU, GTINs, address) and which version
the page shows (the one whose address was read, or whose SKU the page's own
Product states). `resolveVariant` picks this product's version by GTIN, else by
the version whose distinguishing words all appear in the product's name or
recorded version — the most specific one, and only when exactly one is most
specific. Facts about the line are used; the selected option ("Color — Black
(010)", read from the variant picker's `<label>`) is used only when the version
shown is this product's; and a product that is one version the page cannot
resolve gets nothing from the page (`variant_unresolved`, said as such in
preparation). A numeric SKU that is a checksum-valid GTIN matches a recorded
GTIN, for equality only — a SKU that is not this product's barcode is never a
mismatch.

**Intelligent extraction, an optional second reading.** A new provider
boundary, `lib/providers/extraction` (`none` | `anthropic`;
`PRODUCT_EXTRACTION_PROVIDER`, `ANTHROPIC_API_KEY`, `PRODUCT_EXTRACTION_MODEL`,
default `claude-opus-5`), separate from SeoPulse's content provider because the
trust rules are opposite: that one writes from established facts, this one
points at facts in a source. Order, in `lib/pkb/assist.ts`: the deterministic
readers first; the provider only when they found fewer than six value-like pairs
and the page has text; it gets only the text Manifest retrieved (it cannot
browse) and returns strict JSON — label, value, unit, excerpt, section,
suggested meaning, and a kind (identity, product fact, version fact, box
content, composition, use, warning, marketing). The run records what it did
beside discovery ("extraction:anthropic OK — 12 read, 9 confirmed against its
text, 3 discarded", or NOT_CONFIGURED). Provided documents get the same second
reading, before their transaction opens.

**Grounding (`lib/pkb/grounding.ts`), deterministic and strict.** A candidate is
dropped unless its excerpt is in the page's text (folding only case,
whitespace, quote and dash styles, footnote marks and trademark signs; an
ellipsis-quoted excerpt must have every piece, in order, within 1,500
characters); every number in its value and label is a number in that excerpt;
every significant word of its value is stated there (a plural or the same unit,
"min" for "minutes", is allowed); a yes/no value has its label's words in the
excerpt; it is not identity, marketing or an offer term (price, stock,
delivery); and, on a multi-version page, a version's fact names this product's
version. What survives becomes an `ai_assisted` pair whose excerpt is the page's
original text at the matched position (the schema already required an AI
excerpt, `pkb_evidence_ai_quotes_check`). The model's wording survives only as
the label a person is asked about. The pair then takes the ordinary path:
evidence → claim, when a label or mapping names it, or attribute proposal → a
person. Box items arrive one per excerpt and continue the list's positions.

**Verifying AI readings is an owner's opt-in.** The default policies already
refused `ai_assisted` evidence. A new *draft* policy, "Official manufacturer
documentation, read with AI assistance", allows it under the same conditions as
the official-documentation policy (approved official domain for the brand, tier
1). Until someone with `knowledge.manage` activates it, such values can only be
accepted as UNVERIFIED, which does not count as knowledge. Nothing else about
verification changed.

**Family-aware sufficiency (`knowledgeSufficiency`).** `facts` now counts only
facts about the product itself — never identity, price, stock, delivery or
warranty terms. A product needs at least `MIN_PRODUCT_FACTS` (3) of them, every
attribute its family requires, and at least half (up to three) of what the
family recommends; optional attributes are never demanded, so "Measurements" is
no longer universal. With no family, or an empty schema, the verdict carries a
`schemaGap` telling staff to decide the labels research found so the kind of
product is understood next time. The family schema reaches SeoPulse through
`groundedKnowledge().family`. Preparation's message is the verdict's own
summary and missing list. This is stricter than the old rule for products
described only by identity plus two facts, which were "sufficient" before.

**Vocabulary learnt once.** "Add to family" on a product whose category asks for
nothing no longer stops: the first accepted attribute is added to the category,
which creates its family (D-064), and the product joins it. The review screen
groups labels (product facts, this version only, ingredients and materials,
use, warnings, in the box, passages of text), shows the evidence excerpt, the
source, how it was read and what research suggested, lets a person name the
attribute, and offers Map to existing. The mapping is always remembered under
the label the *source* wrote, so renaming "HOW TO USE IT" to "How to use" no
longer stops the next page's "HOW TO USE IT" from being recognised. Migration
0044 adds `pkb_attribute_proposals.suggestion` (kind, meaning, reading method) —
for grouping only.

**Discovery (`buildQuery`).** GTIN, then a strong model code, then brand + exact
name (+ a recorded version the name does not say). No brand, or a name of fewer
than three identity words (two with a recorded version), is not searched. A
result is still only an address.

**SEO waits for knowledge, and says so.** The SEO title and meta description are
not offered, filled or prepared while knowledge is insufficient; the focus
keyword, tags and search terms still are — they describe how people search, not
the product. The rules generator no longer defaults to "… – Price in
Bangladesh" or writes the delivery sentence: its title is the name with a short
established fact when one adds something, its snippet is whole established
statements, and it is empty rather than generic (the schema allows an empty
meta description). In the editor, SeoPulse's own wording is labelled "Previous
SeoPulse content" when the research does not stand behind it (insufficient, or
the latest preparation stopped); an empty section says "SEO will be prepared
after enough product information is verified". A person's wording is never
labelled.

**Smaller generic fixes found on the way.** "Step 1: …" lines stay in their
section instead of becoming attributes called "Step 1"; a long section keeps
whole statements instead of being cut mid-sentence; a value that is a list of
the manufacturer's statements becomes one key feature per statement;
instructions and warnings stay specifications, not key features; "It comes
with finished in Black" became "It comes in Black (010)."; weak codes are no
longer search aliases. Owners see the three optional services — automatic
source discovery, intelligent document extraction, SeoPulse content AI — as
Configured / Not configured / Rules fallback on the Intelligence SeoPulse tab
and under a product's Advanced tools: states only, never a key.

**Known limitations.**

- The Anthropic extraction provider is UNVERIFIED against the live API: no key
  was available. The pipeline around it is tested with a scripted provider.
- A section's deterministic value is capped at 400 characters (a listing's
  specification value caps at 500), so the fourth DETAILS statement on Revlon's
  page — the one saying "100% gray coverage" — is not in the Details fact.
  Intelligent extraction reads the whole text and would propose it separately.
- Lists (tags, search terms) are only added to (D-122), so search terms an
  earlier run derived from weak codes ("10", "1n") stay until a person removes
  them.
- A page re-read after its domain is approved keeps the earlier source row's
  type when its bytes are unchanged; its values qualify only once research
  reads a changed copy (Revlon's page differs on each read, so it did).

### D-123, correctness pass

A second look at the Revlon acceptance found that part of it was accepted for
the wrong reason. Five generic corrections followed; code comments cite D-123.

1. **A page section is not an attribute.** The acceptance had turned
   "DETAILS" and "HOW TO USE IT" into family attributes, "Details" and "How to
   use". Those headings are where the facts are, not what the facts are called.
   Their values were paragraphs cut at 400 characters. The extractor now judges
   a heading's content by shape (`isNarrative`: longer than any kept value, or
   160 characters or more with two or more sentences). A prose section becomes
   an `ExtractedNarrative` (heading, whole text, locator) beside the pairs, not a
   pair. The structured readers propose nothing from it; intelligent extraction
   reads it. Short values ("SBC; AAC; LDAC", "48 Ω (1 kHz)", a two-sentence
   note) are still values. The acceptance database's two attributes and their
   label mappings were removed through the Categories and Sources & Policies
   functions.
2. **Saying what was not read.** When intelligent extraction is not configured
   or fails, the research run's provider entry names the prose sections left
   unread. When knowledge is then insufficient, preparation says the page
   describes the product in prose that was not read into facts. It no longer
   implies the source had nothing. As a result, Revlon without an extraction
   provider now stops honestly: "1 of the 3 facts about the product needed are
   established for the Beauty & Care family". Before, it reached READY on three facts, two of them
   paragraphs.
3. **A trust decision applies to a page already read.** When the Brand Source
   Registry classifies a page (approved, not blocked), a re-read updates the
   existing source row's `sourceType` and `authorityTier`, even when the bytes
   are unchanged. How the page was found (`acquisitionMethod`, `origin`) is
   history and is never rewritten. A read with no registry answer never
   downgrades a row. This removes the D-123 limitation "a page re-read with
   unchanged bytes keeps its old source type".
4. **SeoPulse's own lists are owned like its text.** Preparation's listing step
   and Manual fill now treat tags and search terms by owner. An empty list is
   written. SeoPulse's own unedited list is replaced by the current one, so
   terms derived from a since-corrected value ("10", "1n") disappear. A list a
   person wrote or edited is only added to. A locked list is left alone. No term
   is removed by string matching. This removes the D-123 limitation about stale
   search terms from weak codes.
5. **Weak identity values, reclassified by a person.** `lib/catalog/identity-cleanup.ts`
   finds weak values in Model, Model number and MPN (a variant descriptor, or a
   code `isStrongModelKey` refuses). It offers them for cleanup only once the
   knowledge base has established the product's version (a colour, size or
   other version fact). The notice on the identity section lists each value and
   the established fact it restates, if any. Nothing changes on page load. On
   "Reclassify these values", `POST /api/admin/products/[productId]/identity/reclassify`
   (staff only, `catalog.manage`, fields named by the request, re-checked on
   the server) clears them through the ordinary product update, reassesses
   resolution, and writes a `product.identity_reclassified` audit row with the
   values removed and the facts that justified it. Real codes ("GLO-OC-WL-BLK")
   are never offered.

Also: the "Previous SeoPulse content" notice now says the verified information
does not stand behind the wording, instead of claiming it was written before
research completed (it may have been written after).

**Still open.** The Anthropic extraction provider remains UNVERIFIED against the
live API. Without it, a manufacturer that describes a product only in prose
cannot reach READY from its page alone; staff add facts by hand or configure
the provider. This is the intended, honest outcome.

---

## D-124 — A free, local research and SeoPulse engine

**The requirement.** The owner's original brief was a product-research and
SeoPulse system that costs nothing per product: crawling from the owner's PC,
AI inference on the owner's PC, no paid search API and no paid AI API. Until
now, automatic discovery needed Brave (a paid key), prose extraction needed
Anthropic, and SeoPulse's written content needed Anthropic too. The trust model
does not change here. Only the provider and crawler layer around it widens.
Setup steps for the owner are in `docs/LOCAL_AI_SETUP.md`.

**Configuration.** Every setting is optional, and each absent piece degrades to
what existed before.

```
PRODUCT_RESEARCH_PROVIDER=local        # none | brave | local
PRODUCT_EXTRACTION_PROVIDER=ollama     # none | anthropic | ollama
SEO_PULSE_AI_PROVIDER=ollama           # rules | anthropic | ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=<a model installed in Ollama>   # or OLLAMA_EXTRACTION_MODEL / OLLAMA_SEO_MODEL
SEARXNG_BASE_URL=http://127.0.0.1:8080       # optional
LOCAL_BROWSER_RENDERER=playwright            # none (default) | playwright
```

`lib/providers/local/config.ts` reads these with its own schema, like SEO
Pulse's settings, so research and SeoPulse share it without depending on each
other. No model name is defaulted: the owner chooses one. The old providers
stay for compatibility.

**Local only means loopback.** `OLLAMA_BASE_URL` and `SEARXNG_BASE_URL` are
accepted only for `127.0.0.1`, `localhost` or `::1`, unless
`OLLAMA_ALLOW_REMOTE` or `SEARXNG_ALLOW_REMOTE` is set. A mistyped hosted
endpoint therefore cannot silently receive product documents. Requests to these
services follow no redirects and are size- and time-capped (`localRequest`).
With `ollama` selected there is no cloud fallback of any kind. Extraction
reports UNAVAILABLE and the structured readers stand alone. SeoPulse falls back
to the rules generator, which is also local, and labels the run as rule-based.
While `SEO_PULSE_AI_PROVIDER=ollama`, DataForSEO is not called either, even if
it is configured, so product data does not reach a hosted data service.

**Ollama extraction** (`lib/providers/extraction/ollama.ts`) implements the
existing `ProductDocumentExtractionProvider`. The prompt, the JSON schema and
`readCandidates` moved to `lib/providers/extraction/prompt.ts` and are shared
with the Anthropic provider, so both are asked the same question and held to
the same answer. `/api/chat` is called with `format` set to the schema,
`temperature: 0`, and a configurable context window (`OLLAMA_NUM_CTX`, default
16,384); the document is cut to fit. Manifest parses and shape-checks the
answer itself. A malformed or cut-off answer is asked for once more, with the
problem stated; after that the result is FAILED and nothing from it is kept
(`chatJson`). Every candidate still passes `groundCandidates()`. The model is
not evidence; the page's excerpt is. D-123's rejections (unsupported number,
unsupported value, other version, identity, marketing, offer terms) are
unchanged.

**Ollama SeoPulse** (`lib/seo-pulse/providers/ollama.ts`) implements
`SeoIntelligenceProvider` with the shared prompt and schema
(`lib/seo-pulse/providers/prompt.ts`). The model is shown only
`groundedPromptInput`:

- name, brand and category;
- the rows SEO Pulse itself treats as established (`specificationRows`,
  `measurementRows`), which include `groundedKnowledge()`'s VERIFIED or MANUAL
  values;
- staff-written key features, box contents and description;
- the family's schema and the site's own search data.

It is not shown SeoPulse's own earlier wording (D-120) or offer terms. The
answer goes through `sanitizeGenerated` and then `withholdUnsupportedFigures`.
Any keyword, tag, feature, title, meta description, H1, FAQ answer or
description that states a figure none of those facts contains is withheld.
List entries are dropped; the title, meta description and H1 fall back to the
rules wording; the description's improvements say what was withheld. Words
cannot be checked mechanically the way numbers can, so they are left to the
prompt's rules and to review. Preparation writes this local wording into
fields that are empty or SeoPulse's own once nothing about the product waits for
a person (D-125, which replaces the review-first rule D-124 first inherited). Staff-owned and locked fields
are never touched.

**Free discovery** (`lib/providers/research/local.ts`) has two strategies.

- *Official sitemaps* (`sitemap.ts`), for each domain the Brand Source Registry
  approves for the brand. robots.txt is read first; if it cannot be read, no
  sitemap is read, as for pages, and its rules apply to the sitemap files. The
  sitemaps are its `Sitemap:` declarations, or else `/sitemap.xml` and
  `/sitemap_index.xml`. Indexes are followed product-looking children first,
  and blog, news, image and video sitemaps never. Gzip is supported with the
  same size cap. Only addresses on the approved domain are kept. Limits: depth
  3, 25 files, 50,000 addresses, 10 MB and 15 s per file, 60 s per domain. The
  result is cached per domain in memory for 6 hours (1 hour when empty), so a
  brand's sitemaps are read once for many products. `rankProductUrls` ranks
  addresses by identity: a GTIN in the address, a strong model number
  (`isStrongModelKey`, so never "10"), or most words of the exact name, which
  must be as specific as a search query. Blogs, reviews, categories, carts,
  accounts and promotions are never offered.
- *Local SearXNG* (`searxng.ts`), when configured. It uses the existing
  conservative query (`buildQuery`, moved to `query.ts` and shared with Brave)
  and JSON output. Approved domains are ordered first (`preferOfficial`, which
  now also matches subdomains). A 403 means JSON output is disabled and is
  reported as such. Results are cached 10 minutes per query.

A result is an address. A title and a snippet travel as the provider's note and
are never read as facts. Every address is then retrieved through robots.txt and
`safeFetch`, matched by `identityVerdict`, extracted, grounded and reviewed.
What a strategy could not do is returned as notes and recorded on the run, for
example "1 candidate page — Local web search (SearXNG): the service is not
running …". Only when neither strategy could run is the answer UNAVAILABLE.
Manifest does not scrape Google or Bing, and does not pretend to crawl the web
without an index: known URLs, the registry, sitemaps and a local SearXNG are
the sources.

**Crawler.** `safeFetch` stays the first and usual way a page is read. A page is
rendered only when `needsRendering` finds that its static copy is an empty
JavaScript shell: no Product structured data and next to no pairs, short
visible text, and an empty app mount point, a `<noscript>` asking for
JavaScript, or far more script than text. The rendering replaces the static
copy only when it says more. The run records what happened.

**Browser rendering security** (`lib/pkb/net/render.ts`,
`LOCAL_BROWSER_RENDERER=playwright`, `playwright-core` with its Chromium). The
browser never touches the network itself.

- It starts only from an address that `vetDestination` accepts. That function
  is the `safeFetch` destination check, newly exported.
- Chromium is launched with every host name resolving to nothing and all
  traffic, loopback included, sent to a proxy that does not exist
  (`ISOLATION_ARGS`). A test proves that a page cannot reach a loopback server
  with these flags even when nothing is intercepted; without them it can.
- Every request is intercepted. The page's document is answered from the copy
  already retrieved. Scripts, stylesheets, XHR and fetch requests are retrieved
  by `safeFetch` after robots.txt allows them: public addresses only, redirects
  re-checked, size and time capped, no cookies or credentials. Images, media,
  fonts, frames, WebSockets, beacons, non-GET requests and navigation away are
  refused. Limits: 120 requests, 12 MB, 25 s.
- Each page gets a fresh context, with service workers blocked, no downloads,
  dialogs dismissed and pop-ups closed. The browser is closed in `finally`.
- Nothing is clicked or typed. A CAPTCHA or bot check is reported and not used.

If the runtime or the Chromium binary is missing, rendering is UNAVAILABLE. The
static page is used, with a note that rendering might have helped.

**Related official pages** (`lib/pkb/related-pages.ts`). Links are taken only
from a page that matched the product, and followed one level only, never from
a related page. At most three per page and four per run. A link qualifies when
it is on the same site; when its address or text says specifications,
technical details, support, manual, documentation, details, ingredients, how
to use or FAQ; and when its address shares a word with the product page's
address or the product's identity. A header's generic "Support" link therefore
does not qualify. Reviews, blogs, categories, carts, accounts, promotions,
social links and non-HTML files never do. Each related page is read like any
other candidate and must match the product by `identityVerdict`.

**Setup panel and health.** `researchSetup()` is now async and shows four items:
local web discovery, local intelligent extraction, SeoPulse content AI, and the
crawler. Their states are the ones the brief asks for: Ready, SearXNG not
running, official-domain sitemaps only; Ollama ready, not running, model not
installed, no model chosen; rules mode; static fetch ready with the renderer
ready, off or not installed. `lib/providers/local/health.ts` checks Ollama
(`/api/tags`), SearXNG (a JSON search, which SearXNG refuses before searching
when JSON is off) and Playwright (runtime and binary on disk, no launch). Each
check is bounded to 2–2.5 s and cached for 30 s. The panel streams behind a
Suspense boundary, so the product page never waits for it. It shows states
only, never a secret.

**Not done here, on purpose.** There is no catalogue-wide preparation button
(Part 23 of the brief): the engine is proved on single products first.
Attribute learning is the existing workflow (proposal, then map to existing,
add to family, product only or ignore); an approved mapping is reused for the
family's next product (D-123), unchanged.

**Assumptions.** The sitemap and search caches are in memory: the scheduler and
the web server share a process locally (D-121), and a restart costs only one
re-read. A related page on another subdomain of the same brand counts as the
same site. The robots rules for a sitemap on a subdomain are read from the
approved domain's own robots.txt.

**Verification status.** Phase A (code complete, mocked integration) is
verified; see PROGRESS.md. Phase B, live acceptance against a real Ollama and
SearXNG on the owner's PC, is **UNVERIFIED — local services not installed**.
Neither Ollama nor SearXNG is installed on this machine. Playwright's Chromium
is, and the renderer was run for real against a local fixture.

## D-125 — Local grounded SeoPulse content is written by preparation, not left for review

**The problem.** D-124 inherited D-122's rule that wording from any AI generator
(`generator.kind === "ai"`) is offered for review and never written by
preparation. With `SEO_PULSE_AI_PROVIDER=ollama` that made the owner's one-click
workflow stop short: a run reached READY while the description, key features
and SEO wording stayed empty, waiting for routine approval. The rule was meant
for a hosted model shown the whole product record; the local provider is held
to far tighter inputs.

**The rule.** `applyPreparedContent` writes a run's wording when **all** of
these hold:

1. the run's analysis records `generator.kind === "ai"` **and**
   `generator.localGrounded === true`. The flag is set in `executeResearch` from
   the provider (`SeoIntelligenceProvider.localGrounded`, true only on
   `OllamaIntelligenceProvider`) and cleared when the provider failed and the
   rules generator was used. It is the run's own record, never inferred from a
   label. Runs made before D-125 lack it and stay review-first;
2. the answer passed `sanitizeGenerated` and `withholdUnsupportedFigures`
   (both inside the provider; a malformed answer throws, so the run is labelled
   rules, not AI);
3. `knowledgeSufficiency` is sufficient (unchanged);
4. `undecidedKnowledge` finds nothing waiting for a person at the moment of
   writing: the identity is VERIFIED or HIGH_CONFIDENCE, no claim is CONFLICT
   or SUGGESTED, and no attribute proposal is open. Preparation's own
   verification step already stops for these; asking again here covers a
   decision that arrives while content is generated;
5. per field, the owner (`contentOwnership`, from the change history) is
   **empty** (filled) or **seo_pulse** (refreshed). **staff** is kept exactly
   and reported; **locked** is left alone. Owners are re-read under the
   listing lock before writing, as before.

Fields: description, key features, SEO title, meta description, focus keyword,
and the tags and search-terms lists (replaced when SeoPulse's own, D-123). H1
and slug are not written by preparation for any generator; that is unchanged.

When condition 4 fails, nothing is written, the fields are listed for review,
and the listing step stops the run as NEEDS_REVIEW (`CONTENT_NOT_APPLIED`)
naming what is undecided, so READY is never reached with the listing empty.

**Unchanged.** Hosted AI (Anthropic): review-first, lists untouched. Rules:
written as before. Manual Fill (`fillWithSeoPulse`) keeps review-first for any
AI; this decision is about preparation only. Facts still enter only through
retrieval, extraction, `groundCandidates()`, evidence, claims and
verification; the local model is still shown only `groundedPromptInput`, which
excludes unaccepted candidates.

**Setup text.** The SeoPulse content AI item for Ollama now says preparation
fills empty or SeoPulse-owned fields. `.env.example` states: rules = local, no
AI, no charge; ollama = local AI, no API charge; anthropic = optional paid
hosted AI.

## D-126 — What live acceptance with a real Ollama and SearXNG changed (Phase B)

D-124 and D-125 were tested against fakes of Ollama and SearXNG. Phase B ran
them for real on the owner's PC: Ollama 0.34.4 with `qwen2.5:7b`, and SearXNG
from source, both on loopback. Four problems appeared that the fakes could
not show. Each one is fixed at the local provider, and hosted and rules
behaviour are unchanged.

**1. Slow answers were cut off at 300 seconds.** Unstreamed, Ollama sends no
response headers until the whole answer is written. Node's `fetch` stops
waiting for headers after 300 s (`UND_ERR_HEADERS_TIMEOUT`), whatever
`OLLAMA_TIMEOUT_MS` says. It then reported "the service is not running". On a
4 GB GPU a SeoPulse answer takes 5–7 minutes, so every run fell back to
rules. `OllamaClient.chat` now asks for a streamed answer, so headers arrive
at once. `readChatStream` joins the pieces and uses the counts and stop
reason from the last line. An error line, an unreadable line, or a stream
that never says it is done is a failure, and nothing of it is used. The
answer is still parsed and checked as one piece (`chatJson`). Verified live:
a 327 s answer that failed before is now received.

*Still open:* a request that waits in Ollama's queue behind another one also
gets no headers until its turn. With two generations at once, a wait over
300 s still fails the same way. It falls back to rules, labelled as rules,
but the message says "not running". A complete fix needs a fetch dispatcher
with a longer header timeout, or a `node:http` request. That is broader than
this phase, so it is recorded in PROGRESS.md as SHOULD FIX.

**2. The site's whole synonym table reached the model.** The research sent
to the model included `siteSearch.existingSynonyms`: every synonym row in the
shop. `qwen2.5:7b` returned those rows ("sweets", "sunblock", "frying pan") as
misspellings of a gaming mouse. Under D-125, preparation wrote them into the
listing's search terms. The rules generator had always filtered this table to
rows about the product. That filter is now `relevantSiteSynonyms`, and
`groundedResearch` gives the local model only those rows.

**3. SeoPulse's own earlier search terms were shown back to the model.**
`groundedPromptInput` already excluded SeoPulse's own description and key
features (D-120). It did not exclude its own focus keyword, tags and search
keywords, which it showed as the listing's current search wording. The model
copied the bad terms from item 2 into the next run, so a wrong term would
never leave. `pulseWritten` now also records the focus keyword, tags and
search keywords (from `contentOwnership`), and the model sees only staff's
terms. After the fix, a live regeneration replaced the list.

**4. The site name in titles.** The storefront adds " · Manifest" to every
title (`app/layout.tsx`). The model added it too, in every run, although the
prompt says not to. The page title would then read "… · Manifest · Manifest".
`withoutSiteName` removes a trailing " · / | / - Manifest" from the local
model's titles.

**Model choice.** `qwen2.5:7b` on this machine gave valid structured answers
with `done_reason: stop` in every run. In the runs checked against their
facts, it wrote no figure the facts did not contain; in one run a figure was
written, and `withholdUnsupportedFigures` withheld the description. It runs at
about 3.8 tokens/s under the JSON schema. `qwen2.5:3b` is faster but, at
temperature 0 with this schema, repeated one keyword until the 6,000-token cap,
so the answer was refused as malformed. That failure was handled correctly: it
was not written, and the run used rules. `OLLAMA_TIMEOUT_MS=600000` is set
locally. One attempt fits well inside the 15 minutes after which the job
runner treats a job as stalled. A malformed first answer is asked for once
more, and two attempts can take up to 20 minutes. That exceeds the stall
window, so it is recorded as SHOULD FIX in PROGRESS.md and noted in
LOCAL_AI_SETUP.md.

**Not changed.** Identity rules, the Brand Source Registry, grounding,
sanitising, ownership, H1 and slug, the hosted provider, Manual Fill and the
rules generator's output.

## D-127 — Local AI runs in the background, one generation at a time, and is checked again before it writes

Phase B (D-126) showed that the local pipeline works on ordinary hardware,
and that its runtime was built for fast providers. A `qwen2.5:7b` SeoPulse
answer takes 300–400 s there. This decision is about runtime only: where local
AI runs, how long it may take, how many run at once, and what is re-checked
before its wording is written. Data quality and content wording are left to
later work.

**1. A local model is background work.** `runSeoPulse` queued a run only when
`usesExternalProviders()` was true. Ollama is not external, so a click in the
SeoPulse panel held the web request open for 5–7 minutes. The decision is now
`requiresBackgroundExecution()` (`lib/seo-pulse/runtime.ts`): true for a
provider that declares `usesLocalAi` (the Ollama provider) and, as before,
for a hosted AI or keyword-data provider. Ollama is not labelled external to
pass the old test. The rules generator still runs inline. A queued local run
gets `maxAttempts: 3`: an answer that fails already falls back to rules
inside the job, so a retry is only for a worker that crashed.

**2. A run in progress is judged by its job, not by its age.**
`RUNNING_TIMEOUT_MS` (3 minutes) was shorter than a real generation, so a
second click could start a second one. `seoRunPhase` now reads the run's job:
`queued`, `generating` (a worker has it and shows progress), `stalled` (no
progress for the job's own stale window, so recovery will hand it on),
`inline` (no job, started less than 3 minutes ago) or `abandoned` (job dead
or gone). Only `abandoned` is not live. An abandoned run is closed as failed
("stopped before it finished"), so it no longer blocks a new run. A live run
refuses a second one, unless the caller asks to join it (`joinRunning`, used
by preparation) and its input is the same.

**3. Job recovery is per kind.** `recoverStaleJobs` returned every job
running for over 15 minutes to the queue. With `OLLAMA_TIMEOUT_MS=600000` and
two attempts, a real generation can take 20 minutes, and a second worker
would have started it again. Kinds may now have a `JobPolicy`
(`lib/jobs/policies.ts`), built from the providers in use:

- Only local-model work differs, and only while a local model is in use.
  Hosted and rules-only set-ups return no policies and keep the old limits.
- The window comes from configuration (`localAiRuntime`): one call is both
  attempts at `OLLAMA_TIMEOUT_MS` plus 5 minutes. The queue wait defaults to
  one such call, and a job is the two added together. With 600 s that is
  50 minutes; with the 240 s default it is 26.
- A local-AI job refreshes `locked_at` every minute while it works
  (heartbeat), so the window counts from the last sign of progress. The
  heartbeat stops at a maximum runtime, so no job can stay running for ever.
- `pkb.enrich_product` with Ollama extraction gets the same window and a
  heartbeat, bounded at four calls' worth. It stays in ordinary batches:
  fetching pages is not what needs serialising.

**4. One local generation at a time.** Two generations at once on a 4 GB GPU
both slowed down, and one failed. The local-AI slot
(`lib/providers/local/slot.ts`) allows at most `LOCAL_AI_CONCURRENCY`
(default 1, at most 4) heavy model calls at once:

- In the process, a set of taken slot numbers, checked and taken
  synchronously.
- Across processes, a session-scoped advisory lock per slot, held on one
  reserved connection for the whole call. A process that dies drops its
  connection, and the database releases the lock.
- `chatJson` runs both of its attempts holding one slot and releases it in
  `finally`: after success, provider failure, timeout, malformed answer or
  exception. A call that waits longer than the queue wait gets
  `OLLAMA_QUEUE_WAIT_TIMEOUT`.
- The job runner never claims a local-AI job in an ordinary batch, where it
  would hold up the jobs claimed with it. `runLocalAiJob` takes a free slot
  first, then claims one local-AI job and runs it holding that slot. If no
  slot is free, nothing is claimed and the job stays queued for a later call.
  The model call inside finds the slot held and does not queue behind itself.
- The scheduler route runs the local-AI lane with `after()`, once its
  response is sent, so its own request is not held open for minutes.

A session lock needs a direct connection. Through a transaction pooler it
would not be pinned to anything. Local AI runs against the local database,
which is direct, and the migration lock relies on the same thing. Serial
generation also removes the D-126 problem where a request queued inside
Ollama got no headers for 300 s: requests no longer queue there.

**5. Preparation waits for the same run.** The content step stores
`seoRunId` as soon as it asks for a run. Every later wake-up reads that run's
phase and waits (queued or generating), goes on (completed) or stops
(failed or abandoned). A wake-up never starts a second generation for the
same attempt. A wait on a job that is still live is not limited by
`MAX_TICKS`: it is bounded by the job's own stale and retry limits, and a
queue that never moves stops after four jobs' worth of time. Content waits
are 20 s apart instead of 8. When a staff member's panel run is already
generating from the same input, preparation joins it.

**6. Local-model failures are named.** `OllamaFailureKind` is now
`unreachable | refused_address | timeout | model_missing | malformed |
incomplete | error | queue_timeout`. `localAiFailureCode` maps these to
`OLLAMA_UNAVAILABLE`, `OLLAMA_MODEL_NOT_FOUND`, `OLLAMA_GENERATION_TIMEOUT`,
`OLLAMA_QUEUE_WAIT_TIMEOUT`, `OLLAMA_MALFORMED_RESPONSE`,
`OLLAMA_INCOMPLETE_STREAM` and `OLLAMA_PROVIDER_ERROR`.

- An unreadable stream line is now `malformed`, and a stream that never says
  it is done is `incomplete`; both were `error` before.
- SeoPulse's provider throws `LocalAiError` with the code. The failed usage
  row keeps it (`errorCode`), and the analysis records
  `generator.fallbackFrom` with the provider, code and message. The run is
  still recorded as rules with `localGrounded: false`.
- Extraction results keep it as `code`, and the research run's provider state
  shows it in brackets.
- No model answer is stored in any of these.

**7. The final write boundary.** D-125 asked "is anything undecided?" before
generating. The answer can change during a 6-minute generation. The
`applyPreparedContent` guard now runs inside the apply transaction, after the
listing lock and before any write, and checks everything the write depends
on:

- ownership, as before: a field saved or locked meanwhile is not written;
- for local grounded wording, that the product is not archived and still has
  the same knowledge record;
- `undecidedKnowledge` (now executor-aware, the one implementation) read
  under the product's knowledge lock.

`lockProductKnowledge` is a transaction advisory lock per knowledge product.
Every change that could put something in front of a person takes it:
`createClaim`, `proposeFactClaim`, `proposeAttribute` and `refreshResolution`.
No such change can commit between the check and the write. Decisions that
only close questions (accept, reject) do not need it.

- Lock order: the listing lock first, then the knowledge lock. A staff save
  already holds the listing lock when it re-assesses identity, and the apply
  holds it when it checks.
- If the check fails, nothing is written. The run is kept and not marked
  applied. Preparation stops at `CONTENT_NOT_APPLIED` and names what is
  undecided.
- A listing conflict at the boundary (a person saved a field SeoPulse meant
  to fill) is now treated like an ownership change: preparation decides
  again against what they saved, keeps their words and fills the rest.
  Before, it stopped for review.

**Not changed.** Identity matching, grounding, sanitising, the figures check,
D-125 ownership and auto-apply rules, D-126 streaming, the hosted provider,
the rules generator, and every job kind's limits when no local model is in
use. No migration: the slot uses advisory locks, and phases are read from the
existing `jobs` rows.

## D-128 — Product data quality, SeoPulse content quality, bulk review, short SKUs, English-only research

Live acceptance (D-126, D-127) produced listings with doubled units ("2685 MHz
MHz"), page furniture as specifications ("Get Educated → … Learn More"), a
manufacturer's warranty treated as a product fact, Key Points repeating At a
Glance, SKUs made of whole titles, non-English pages read for facts, and
generated wording with claims the facts did not make. Every rule below is
generic: none names a brand, a product or a category, and each is tested with
invented products from unrelated families.

**1. A unit is written once** (`lib/pkb/unit-text.ts`). `valueWithUnit(value,
unit)` appends a unit only to a value that ends in a number and does not
already end with that unit; a value that spells its own unit ("7.97 ounces
(226 grams)") is left alone. `collapseRepeatedUnits` repairs a doubled unit
only straight after a number ("2685 MHz MHz"), never ordinary repeated words.
There is no unit list. Every join goes through it: claim creation (review and
evidence — this was the source of the doubled values), category attribute
display, structured data, SeoPulse's fact rows, the local model's view, the
review screen, the product page's specification rows and At a Glance, and the
quality gate on generated text. Evidence keeps the page's own words.

**2. What may become candidate knowledge** (`lib/pkb/candidate-quality.ts`).
`candidateRejection(label, value)` runs in `proposeFromExtraction`, the one
place every reader's rows — structured, text, and AI-assisted — become claims
or attribute proposals. It refuses: a warranty (`WARRANTY_EXTERNAL`);
decoration only (`DECORATIVE`: emoji, ticks, stars — but never Ω µ ° ± × ²
® ™ ©, which are kept); calls to action as label or value, navigation words as
a label, a value trailing off into "Learn More", persuasion and URLs
(`SOURCE_NOISE`); and a label that is a sentence, a value that only repeats its
label, or reader-addressed prose with no figure (`NOT_A_SPECIFICATION`). It is
conservative: any short plausible label with a plain value passes, numeric or
not, and an unfamiliar label still becomes a proposal for a person. The
retrieved document's text is stored unchanged.

**3. Warranty is manual-only** (`lib/pkb/warranty-policy.ts`, the one place
that decides it). A researched warranty never becomes a claim or a proposal
(candidate gate), never reaches a generator (`groundedKnowledge` drops any
warranty attribute, whatever its state), never reaches structured data
(`publishableKnowledge`), never enters SeoPulse's facts, At a Glance or Key
Points (`content-plan.ts`), and generated text mentioning a warranty is
removed unless the listing's own Warranty & safety field says there is one.
That field (`products.warranty`) is untouched by research and is passed to the
model as `manualWarranty`.

**4. At a Glance and Key Points have different jobs**
(`lib/seo-pulse/content-plan.ts`).

- *At a Glance*: up to five short label → value facts for scanning, chosen
  deterministically from established facts — the family's required, then SEO
  relevant or filterable attributes first (`familyGlancePriority`), otherwise
  short specific values. Identifiers, offer terms, warranties, instructions
  and long values are left out. The product page now shows this instead of
  the first four bullets.
- *Key Points*: one established fact each, read as a shopper reads it —
  `keyPointFromFact("Memory", "12GB GDDR7")` is "12GB GDDR7 memory". The rules
  generator writes them this way, and the quality gate rewrites any
  "Label: value" line a model returns. Nothing is added that the fact does
  not say.

**5. Bulk review in Product Intelligence** (`panels.tsx`,
`lib/pkb/claim-selection.ts`). Filter chips (all waiting, proposed, in
conflict), a "Select all shown" checkbox, a selected count, Clear, and a
sticky action bar with Accept selected, Accept as verified and Reject
selected. Select all takes only the open claims the current filter shows; an
action acts only on what is selected *and* shown. Selecting decides nothing.
Decisions go through the existing endpoint and `acceptClaims`/`rejectClaims`
— same permission check, verification policy, evidence, per-claim decision
fields, fact history and audit (which lists every claim id) — in groups of at
most 100, each all or nothing; the first refused group stops the rest, and the
screen says how many were decided and why the rest were not. Rows now show the
attribute, the value with its unit once, the source and the evidence excerpt.

**6. Short generated SKUs** (`lib/catalog/sku-generator.ts`).
`BRAND-MODEL-VARIANT…`: the brand's first word (≤8), the model or part number
compacted (or a short title token: the first word with a number and the word
before it, or two words), and each variant value (≤8). ASCII A–Z 0–9 and "-",
shortened towards 40, always ≤64. Collisions get "-2", "-3" … within 64. Used
for the primary variant, generated combinations, a variant added by hand, and
duplicates (`-COPY` within 64). A SKU is never regenerated except when an
option value is renamed, and then only for variants whose SKU is still exactly
what the generator produced (`refreshGeneratedSkus`); a SKU staff typed never
matches and stays byte for byte, and order lines keep their own SKU snapshot.
The product-level SKU (`SKU-000001`, reserved when the Add Product form opens,
before brand or model is known) is unchanged. Manufacturer identifiers (MPN,
model number, GTIN) stay in their own fields.

**7. Specification quality gate** — see 2; it is the same gate, applied before
a row becomes a claim or a proposal.

**8. English-only research** (`lib/pkb/language.ts`).

- *Discovery*: SearXNG is asked for `language=en`, Brave for
  `search_lang=en`; results and sitemap URLs that name an English locale rank
  first and ones naming another language last (`urlLanguagePreference`) — a
  hint only.
- *Reading*: before a retrieved page is read into anything — and before the
  optional AI reading, so a model never sees it — `detectLanguage` decides
  from the visible text (writing system; which language's function words it
  is made of; for thin pages, common English page words at half weight),
  with the declared language (`<html lang>`, Content-Language,
  schema.org `inLanguage`) used only when the text is too thin to decide and
  never against clear text. English → read; another language →
  `NON_ENGLISH_SOURCE`; too little or mixed → `LANGUAGE_UNCERTAIN`. Both are
  recorded as refused documents. A few foreign navigation or footer words do
  not outvote an English page.
- *English version*: a refused page's `hreflang="en…"` alternates are read
  instead, at most three per run and never an alternate's alternate.
- *Official is no exception*, and there is no translation path: nothing from
  a refused page reaches evidence, claims, proposals, the model, or content.
- *Staff documents*: a pasted document clearly in another language is
  refused (422, NON_ENGLISH_SOURCE); a short one that cannot be told is
  accepted, because a person chose and read it.
- *Output*: the quality gate removes non-English sentences, key points,
  alt text and non-Latin search terms; the product's own names are not
  counted as foreign.

**9. SeoPulse content architecture.** Established facts → `contentPlan`
(deterministic) → one model call → `applyQualityGate` (deterministic) →
ownership and the D-127 final write check. The plan ranks facts by the
family's attribute order and requirement, else by specificity, and bounds them
at 12; names the exact title to use once and shorter names built from the
product's own brand and model; chooses depth (simple / medium / detailed, with
useful-word guidance that is never a target); lists sections only where some
fact belongs in them (a perfume gets no connectivity paragraph); and carries
At a Glance so Key Points say something else. The prompt adds rules for the
plan, claim strength, filler, warranty, English and the separate jobs of
description, title, meta and search terms. Still one generation: no critic,
no rewrite.

**10. The quality gate** (`lib/seo-pulse/quality.ts`), on every generator's
answer (local, hosted, rules) before it is stored; the local provider runs it
before its figure check too, so one bad sentence no longer takes the whole
description down. Sentence by sentence: sales filler and page furniture
removed; evaluative words ("exceptional", "premium", "lightweight", "clear
sound", "best", "ultra-…", "most …") removed unless the established facts use
the word themselves; warranty without a manual warranty removed; non-English
removed; doubled units repaired. Across the description: the exact title used
once, later uses replaced by a short identity name; a fact stated twice is not
stated a third time; empty headings and lists removed; malformed markup or
fewer than five words left → the description is withheld. Key points rewritten
from "Label: value". A stuffed or promotional title → the rules title. The
meta description is fitted at a sentence, then clause, then word boundary,
never ending on a comma or a dangling "and" — `fitMetaDescription` also
replaces the old 170-character cut in `sanitizeGenerated`. What was repaired
and withheld is stored on the run (`analysis.quality`).

Added after the first live run with `qwen2.5:7b`, which the gate above let
through: a sentence that *opens* by telling the reader to experience,
discover, unlock or feel something ("Experience the power of the …") is sales
filler (a sentence merely containing "experience" is not); "high-performance",
"high-end", "top-tier", "next-level", "next-gen" and "flagship" are evaluative;
search terms, tags and brand variations are held to the same evaluative rule
as sentences (a "high end" tag goes); and the brand and model name count as
established text, so a brand that happens to contain such a word is not
dropped from its own terms. The adverb makes the same claim as its adjective
("smoothly" as "smooth").

Dropping a whole sentence for one adjective lost, on the second live run, the
opening sentence that named the product; the description began "It features
…". A sentence whose only fault is praise used in front of another word now
has that word taken out instead (`withoutPraise`: "is a high-performance
graphics card" → "is a graphics card", "an exceptional cooler" → "a cooler").
It is dropped as before when the word is predicative ("It is exceptional."),
one half of a pair or after a degree word ("compact yet powerful", "a more
immersive experience" — found on the third live run), a "most …" phrase, when
the sentence has another fault, or when fewer than four words are left.

Not fixed: a model title that is the product name cut at 70 characters can
end on an adjective ("… 12GB GDDR7 Graphics"). The rules title also fits a
long name by cutting it, so treating any cut name as a fault would reject the
fallback too; choosing a better cut is left for later.

**Not changed.** D-127's background execution, local-AI slot, stale policy,
seoRunId reuse, streaming and error codes; the final write boundary,
ownership, locks, D-125 auto-apply rules, the localGrounded, rules and hosted
distinctions; identity matching; grounding; verification policies. No
migration.

## D-129 — SeoPulse content polish, and English-only research checked against real search results

D-128 left five things recorded as limitations. This change fixes the four
about wording and checks the fifth live. Every rule is deterministic, runs
after SeoPulse's one model call, and names no brand, product or category. No
second model call, no prompt change, no migration.

**1. SEO titles are shortened by meaning** (`lib/seo-pulse/title-fit.ts`,
`fitSeoTitle`). A long name used to be cut at 70 characters (a model's
title, in `sanitizeGenerated`) or at 49 (the rules title, `clampText`), which
could end on half a phrase: "… 12GB GDDR7 Graphics". The name is now read as
units — a word, a number with its unit ("12GB", "50 ml"), a bare number with
the word before it ("RTX 5070"), "Pack of 2", a bracketed aside, a phrase
after a comma, bar or dash — and whole units are taken out, least useful
first: repeats, praise (the D-128 evaluative list, now in `claim-words.ts`)
and "New"; asides; a descriptive phrase after "for"/"with"; descriptive words
the facts already state; other descriptive words; descriptive words inside the
recorded model name; technical codes the model name does not contain;
quantities. Never taken out: the first word, the brand's first occurrence,
coded words of the model name ("EPIC-X", "WH-1000XM5"), words the product's
family or any level of its category names, a variant's value (colour, size,
"Size 10", "Shade 150") and a short last phrase after a dash ("- 150 Buff").
With no recorded model, the first word after the brand and every code in the
name are kept too. When neither the family nor the category names a word of
the title, the product-type noun is taken to be the last one or two
descriptive words of the name ("Graphics Card", "Eau de Parfum").

Length follows the rules already in the repository: aim for 49 characters so
the page title with " · Manifest" stays within 60 (the rules generator's
target), and allow up to 60 (the readiness policy, `lib/seo/readiness.ts`)
rather than lose part of the protected identity. Only a name whose protected
identity alone is longer than 60 is cut, at a unit boundary; a single word
longer than 60 is kept whole rather than broken. A trailing " · Manifest",
" | Manifest" or "- Manifest" is removed however many times it appears. A
name that fits is returned unchanged. The same function is used by the rules
title, by `sanitizeGenerated` for a model's title and alternatives, and by
the quality gate.

**2. A description names its product in its first sentence**
(`gateDescription`, `openingSentence` in `content-plan.ts`). When the opening
is dropped — praise that cannot be taken out, sales filler — or never named
the product, and the sentence now first does not say which product this is
(the exact name, a short name from the plan, or the brand with the name's
first distinctive word or a word with a figure), a plain opening goes first:
"<exact name> has <fact> and <fact>." with at most two established facts
from the plan that read well inside a sentence (figures and codes first, never
a fact the name already says, a list, an instruction, a value over 40
characters, a label naming a company — "Chipset manufacturer" — a size,
weight or count, or a raw data key such as "milliamp_hours"; the last three
found on real listings), "have" for a name whose last word is plural; or only "This is the
<exact name>." when no fact reads well. It is checked by the same sentence
rules and never added to a description that has fewer than five words of its
own — that is still withheld. The exact-name-once rule runs after it, so later
uses become the short name.

**3. Sentences with nothing to say** (`thinSentence`, `withoutThinClauses`).
A sentence with no figure made only of grammar, a generic subject ("it",
"users"), a generic verb ("delivers", "offers", "designed") and a generic noun
("performance", "quality", "experience") is dropped — word classes, not a
phrase list; any other word ("cooler", "rosewater", "Bluetooth") is something
said. When praise is taken out of one clause of a sentence, that clause alone
is judged more strictly (a generic verb with at most one other word and no
established fact, brand or model word: "delivers graphics") and dropped, while
the rest stays: "The card uses 12GB GDDR7 memory and delivers high-performance
graphics." → "The card uses 12GB GDDR7 memory." If the first clause is the
empty one, the sentence goes.

**4. The rules meta description is one sentence** (`factMetaSentence`).
Before: "<name> – <fact>: <fact>; <fact>." Now: "<name> features <fact>,
<fact> and <fact>." — the same facts as the opening, at most three, fewer when
that is all that fits in 155 characters, "for <use>" only when the listing
states an intended use (and it is not praise), "feature" for a plural name.
Staff's own short English feature lines stand in only when no fact reads well.
Nothing reads well → no meta description (withheld, as before). This is the
meta the quality gate falls back to when a model's is refused; D-125
ownership and locks are unchanged, so a staff-written or locked meta is never
replaced.

**5. English-only research, live.** A bounded run with the real SearXNG
(`PRODUCT_RESEARCH_PROVIDER=local`, `language=en`) for a real product with an
international manufacturer, through the normal pipeline (safeFetch, robots,
the 12-candidate bound, the renderer rules), with the document-reading model
replaced by a recorder so no generation ran. Real results asked for in
English still included Polish, Lithuanian, Portuguese, Spanish and Russian
shop pages. The ones that answered were refused before anything was read — a
Russian page as NON_ENGLISH_SOURCE, two Polish pages (thin, script-rendered)
and a Lithuanian page (mixed) as LANGUAGE_UNCERTAIN — never shown to the
recorder, and left no evidence, claim or proposal. English pages were read.
Details in PROGRESS.md.

Found live and fixed: a manufacturer's official English page at
`/gb-en/…` (country first) was ranked as another language by
`urlLanguagePreference`, and `/sg-en/…` was not recognised as a locale at
all. A locale whose second part is "en" now counts as English. This is only a
ranking hint; the page's own text still decides.

Not validated live: following a refused page's English hreflang version. No
refused page in these runs declared one; a manufacturer's declared non-English
versions answered 403 or 404 to Manifest's fetcher, and those answers were
respected rather than worked around. The path stays covered by the D-128
automated test.

**Not changed.** D-127 background execution, local-AI slot, stale policy,
seoRunId reuse and the final write boundary; D-128 units, the candidate gate,
warranty policy, SKUs, bulk review, At a Glance, Key Points, the language
gate itself, claim-strength filtering and ownership. The prompt is unchanged.
No migration.

### D-129A — generic predicates left by praise removal

The isolated live run (PNY, `qwen2.5:7b`, 463 s, `kind: ai`,
`localGrounded: true`) kept "this graphics card delivers performance for 4K
gaming …" and "a triple-fan cooling system to ensure performance and
stability": the clause-level check let a clause through because it held a
figure or other words. `withoutGenericPredicates` now runs on every description
sentence (after praise removal and before the clause check, for a sentence
praise was taken out of). It looks for a generic verb
of the "delivers / provides / ensures / offers" kind whose object is only
generic nouns ("performance", "quality", "stability", "experience"), and
removes that predicate with what depended on it: a following "for / in /
during / to …" phrase up to the end of the clause, and the "to", "and",
"which" or comma that joined it. When a subject came before the verb, the
whole clause goes. Nothing is put in its place — no "built for", "ideal for"
or "supports". A sentence left empty, under four words, or only an
introductory phrase ("With a boost clock of 2685 MHz.") is dropped. A real
object is never touched: "delivers 28 Gbps memory speed", "provides 100W
output", "supports 4K at 120Hz", "offers four USB-C ports", and a measured
"performance of 800 lumens" stay.

It runs on every description sentence, not only those the praise gate
changed: a model can write "delivers performance for 4K gaming" with no praise
at all. A sentence with no such predicate is left byte for byte. An object
the established facts' values state is a fact, not an empty claim ("ensures
stability" stays when a fact says "Anti-sag bracket for stability"). An
opening removed this way gets the D-129 plain opening.

## Search autocomplete request control (patch, no new phase)

The header search asked for suggestions 160 ms after the last keystroke,
aborted the superseded request in the effect cleanup, and hid an answer whose
term no longer matched the field. It also asked while the list was closed
(landing on `/search?q=…` fetched suggestions no one saw), a submitted search
left its timer running, the loading mark showed the moment a request went out,
and the per-visit answer cache had no bound.

Request control now lives in `lib/search/autocomplete.ts`, free of React so
the timing is tested with fake timers:

- `SEARCH_DEBOUNCE_MS = 250`. Only the request waits; the field, the clear
  button, focus and the keyboard never do. Every change of the trimmed query
  restarts the wait.
- `SEARCH_MIN_CHARS = 2`, on the trimmed query; internal spaces are sent as
  typed. The suggest route uses the same constant for its own floor.
- A newer query, a query under two characters, or closing the list aborts the
  request in flight and clears the timer. An abort is never shown or logged as
  a failure.
- A generation counter, bumped on every new query and every cancel, decides
  whether a response may be shown. A response that finishes after its abort,
  or after a newer query, is dropped and not cached. This does not depend on
  timing.
- The box asks only while the list is open. Enter, the Search button, choosing
  a suggestion, Escape and leaving the field all close it, which cancels
  pending and in-flight work. The search itself is the form's normal submit
  and goes at once.
- The loading mark shows only once a request has been out 150 ms
  (`SEARCH_LOADING_DELAY_MS`, not part of the debounce).
- The existing cache is kept: exact trimmed query, lowercased, successful
  answers only, now bounded to 50 entries, oldest dropped first. A cached
  answer is shown at once without a request.
- Every applied answer resets the highlighted option, so Enter can only take
  an option from the list on screen.

Unchanged: the suggest endpoint and SearchPulse ranking. One answer is bounded
by the service (at most 4 products, 2 shelves, 2 named categories, 2 brands,
6 searches — 16 in all) and carries only label, link, thumbnail, hint, public
price and scope. It reads 40 candidate rows of id/title/slug/brand/category
and card aggregates for the 4 shown products; no descriptions, facets or
recommendations. The route keeps its two-character floor and its in-memory
per-visitor limit (`SEARCH_SUGGEST_LIMIT`, default 40 per 10 s). The client
debounce is a courtesy, not that protection.

## D-130 — Product identity-aware SEO titles and deterministic grammar

D-129 left four deterministic weaknesses: the product type was guessed from
the last words of the name whenever the family or category did not name it
("… Olive Oil Cold Pressed Glass Bottle" protected "Glass Bottle"); every
protected unit was equally immortal, so a guess was kept as firmly as a model
code; a name whose protected identity passed 60 characters was cut at 60,
which could drop a variant's value; and "<name> has / have …" chose its verb
from the name's last word ("… Series", "… Lens", "… Edition"). All fixes are
deterministic. No model call, no prompt change, no migration, no UI change.

**Product type** (`lib/seo-pulse/product-type.ts`, `resolveProductType` in
`title-fit.ts`). Strongest source first: the knowledge base family; the
product's own category when it is specific — the last level of the path, with
no categories under it, that carries a default family or that the title
names (every level above, and any category with children, is a grouping); a
recorded product type (`product_type`, "Product type", "Item type"); then the
title, as a last resort. From the title, a phrase is taken only when the
listing's own words repeat it (search keywords, tags, focus keyword, staff
features and description — never SeoPulse's own earlier wording, D-120), or
the closing words of the name when nothing suggests a descriptive tail: an
-ed word between the start of the name and those words ("Cold Pressed",
"Vacuum Insulated"), or one of them a value the facts state (a material, a
container). Otherwise the type is unknown, and nothing is protected as the
type. The input now carries `categoryShape` (has children, has a default
family), read from categories already loaded; it is left out of the input
hash so earlier runs are not marked out of date.

**Title identity hierarchy** (`fitSeoTitle`). The D-129 removal order stays
for normal material (praise and repeats, asides, "for/with" phrases,
fact-stated words, other descriptive words, descriptive model words, codes the
model does not contain). Added:

- after a confirmed type, the descriptive tail that follows it ("Cold Pressed
  Unfiltered Glass Bottle") goes first among descriptive words, whole;
- a word and the -ed word it qualifies go together ("Cold Pressed"), and
  praise spelled over two words ("Long Lasting") is praise in both;
- **strong** tier, removed only when the title would otherwise miss 49: the
  product line read from the name (no recorded model), a first word that is
  not the brand, a quantity no variant records, a type guessed from the end
  of the name;
- **critical**: the brand, the recorded model's name word and codes, the
  short word completing a model code ("Ti", "Pro", "Ultra"), a recorded
  variant value (listing variants, variant details, variant-level knowledge
  facts, a product-level capacity, storage, volume, size, shade,
  concentration or generation), a generation ("Gen 3", "3rd Gen"), every
  code in a name with no recorded model, a joiner inside a variant value
  ("Wi-Fi + Cellular"), and a confirmed product type (with it, when no
  brand is recorded, the first word of the name).

"11 Tablet" is no longer read as a count ("60 Tablets" and "1 Tablet" are).

**Preferred length vs identity.** 49 is the goal (60 with " · Manifest"),
60 the readiness limit, both unchanged. Critical identity is never removed to
meet either: it may pass 60, up to 70 (`SEO_TITLE_HARD_MAX`, what a stored
SEO title holds; readiness then reports the title as long). Only past 70 does
the confirmed type go, then whole codes from the right, and only then is the
name cut at a unit boundary; the brand, the model's name, a variant's value
and a generation go last. Variant safety comes from the ranking itself, not
from checking uniqueness afterwards: two listings that differ in capacity,
shade, size, generation, connectivity or model suffix keep that difference.
The site's name is still stripped however often it appears, and the page
adds " · Manifest" once.

**Grammar.** No sentence verb depends on the product name any more. The plain
opening is "Key specifications of the <name> include <fact> and <fact>.";
the rules meta "Key specifications of the <name> include <fact>, <fact> and
<fact>.", with ", intended for <use>," when the listing states a use, and
"Key features …" when staff's own lines stand in for facts. "include" suits
any fact (a colour, a clock speed, a port). With no fact that reads well:
"This listing is for the <name>." — added only when no sentence of the
opening paragraph already names the product. A name that starts with an
article is not given another. Lists are built from cleaned items and the
sentence is tidied of doubled spaces, spaces before punctuation, doubled
commas and a doubled "and". The D-129 fact filter, the exact-name-once rule
and the sentence checks are unchanged.

**Not changed.** SearchPulse and the search patch; D-127 runtime and
concurrency; D-128 units, warranty, English-only, SKUs, At a Glance, Key
Points; D-129 praise and generic-predicate removal; FAQ, alt text, tags and
aliases (out of scope). A staff-typed meta title that itself ends in
" · Manifest" is not stripped on the product page (SeoPulse never writes one).

## D-131 — Accepting a value is not verifying it, and the screen says which

**The defect.** The final campaign's live run (PROGRESS.md) accepted eighteen
retailer values and stopped at `INSUFFICIENT_KNOWLEDGE`, whose remedy began
"Accept the values research found". They had been accepted. A plain Accept
records a value as UNVERIFIED when no verification policy qualifies its
source; only VERIFIED and MANUAL values are established knowledge (I-11), so
content generation correctly refused to write from them. The stop was right
and the instruction was wrong, and the next read of the same page proposed the
same eighteen values again, because `createClaim` closes a repeat only of a
value a person *decided as VERIFIED or MANUAL* (D-122).

**The distinction, unchanged.** A staff decision (Accept / Reject / Correct)
and a fact becoming established are two things. Accept writes the fact with
its source and the deciding person, as UNVERIFIED. It becomes VERIFIED only
through "Accept as verified", which requires `evaluateVerification` to find an
active policy the claim qualifies under at that moment. No policy, registry
rule, source type or sufficiency rule was changed, and nothing is promoted.

**What changed.**

- `stepContent` reads which accepted values are UNVERIFIED (a fact with
  `decided_by` set) and are not already counted through the listing. When
  there are any, the note says so by name — "4 values were accepted without
  verification (…), so they do not count as established" — and the remedy
  says that accepting them again changes nothing, and names what does: the
  manufacturer's own page or its official specification, then "Accept as
  verified" in Product Intelligence (a manufacturer's page qualifies once its
  domain is approved for the brand in Sources & Policies), or the
  specifications entered by hand. Every one of those is an existing action.
  With nothing accepted, the remedy no longer mentions accepting at all: by
  the content step nothing is waiting, or the verification step would have
  stopped the run.
- `CLAIMS_WAITING` no longer promises "Accepted values then count as
  established knowledge". It says a value counts once accepted as verified.
- The review screen's result line for a plain accept reads "Accepted N values
  as unverified.", and "How complete is it?" explains the Unverified count
  when it is not zero.
- **Repeats.** A claim that repeats a value a person accepted as UNVERIFIED
  is judged once, on arrival: if a policy would verify it now — the domain was
  approved since, a second independent source arrived, an official document
  was supplied — it stays SUGGESTED, because "Accept as verified" on it is
  exactly what establishes the value. If none would, it is closed as
  SUPERSEDED with its evidence kept and a note, like the D-122 repeat: no
  decision is recorded, the fact is untouched. A different value is still a
  CONFLICT; a legacy or copied UNVERIFIED value nobody decided is still
  proposed as before. The test is "would deciding this change anything", not
  "is it the same source": a second retailer saying the same thing changes
  nothing either, unless a two-source policy is active and now satisfied, in
  which case the claim is eligible and stays open.

**Found, not changed.** A system attribute that is also a field of the
listing (colour, material, item weight, country of origin) is written into the
listing's details when its claim is accepted, verified or not, and
`knowledgeSufficiency` counts listing details. So plain Accept does establish
enough for those attributes; it does not for attributes that exist only in the
knowledge base, which is what a retailer's specification table mostly yields.
This predates D-131 and is left as it is: changing it either way is a
verification-policy decision, not a wording fix.

## D-132 — Real email goes out over SMTP, and a failed message waits before it is tried again

**Context.** The notification boundary (D-004) had one implementation, the
mock. `NOTIFICATION_PROVIDER=live` threw. Staging needs real email, and the
owner has not chosen an email service.

**Decision.** One adapter, `SmtpNotificationProvider`
(`NOTIFICATION_PROVIDER=smtp`, replacing the value `live`), using
`nodemailer`. SMTP because every transactional email service speaks it:
choosing or changing the service is a change of `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASSWORD` and `EMAIL_FROM`, and no code names a vendor. Its
settings are read in `lib/providers/notification/config.ts`, apart from
`lib/env.ts`, so a mistake in them cannot stop the site from starting.

What the adapter holds to:

- Plain text only, so nothing a customer typed becomes markup.
- One recipient, validated before any connection; the subject on one line;
  no file or URL is ever read into a message.
- TLS always: implicit on 465, STARTTLS required on any other port.
- A failure is recorded by its kind (`describeSmtpFailure`), built from the
  reply code, never from the provider's text: no password, user or host
  reaches the outbox row or a log.
- `NOTIFICATION_RECIPIENT_ALLOWLIST`: when set, only those addresses or
  domains are written to. Staging sets it; production does not.
- SMS is refused with a reason. The outbox still models the channel.

The outbox changed in three ways, all behind its existing interface:

- **Backoff** (migration 0045, `notifications.next_attempt_at`). A failed
  message used to be retried every minute and parked after five attempts, so
  a provider that was down for ten minutes lost what was queued. It now waits
  1, 2, 4, 8, 16, 32 and 60 minutes, eight attempts in all — about two hours.
- **Permanent failures stop at once.** `DeliveryError` carries `permanent`;
  a refused mailbox or a recipient outside the allow-list is not tried again.
- **An idempotency key**, the outbox row's id, on every attempt.

**Accepted.** SMTP has no idempotency key. A crash after the provider accepts
a message and before the row is marked sent delivers it twice; both copies
carry the same Message-ID. An HTTP API with real idempotency would close this,
at the cost of naming a vendor; it can be a second adapter later.

**Not verified.** No message has been sent through a real SMTP service: no
account exists. The adapter is tested against nodemailer's own message
composer, with failures injected.

## D-133 — Staging runs off the owner's computer: a worker, private research services, one health report

**Context.** Research and AI ran on the owner's PC: SearXNG and Ollama on
loopback, jobs driven by `npm run dev`. With the PC off, nothing in the
background ran. On Vercel the job trigger is a serverless function: it cannot
reach a private service and cannot live through a ten-minute generation.

**Decisions.**

1. **A worker process, not a second job system.** `npm run worker`
   (`scripts/jobs/worker.ts`, `lib/jobs/worker.ts`) is the job trigger
   without the request: same registry, runner, SKIP LOCKED claiming,
   heartbeats, stale recovery, retries and local-AI lane. Ticks start on an
   interval and may overlap up to `WORKER_MAX_CONCURRENT_TICKS`, as a
   scheduler's calls do, so a slow research job does not hold up message
   delivery. The PostgreSQL queue is unchanged; nothing was added beside it.
2. **`JOB_RUNNER=worker`** makes `/api/cron/jobs` decline (200, nothing
   claimed). Without it a leftover cron would claim a research job in a
   function that cannot reach SearXNG or Ollama, and the run would finish
   degraded instead of waiting for the worker.
3. **Remote services stay opt-in, and must be private or encrypted.**
   `OLLAMA_ALLOW_REMOTE` and `SEARXNG_ALLOW_REMOTE` already existed and are
   kept: changing an address alone sends nothing anywhere. Added: a remote
   address must be on a private network (a private IP, a single-label service
   name, a name under `.internal` or `.local`) or use https; and
   `OLLAMA_AUTH_TOKEN` / `SEARXNG_AUTH_TOKEN` are sent as a bearer token to a
   gateway. A gateway that refuses is `OLLAMA_UNAVAILABLE`. "Private" is
   judged from the name the operator wrote, with no lookup; the application
   cannot check a firewall.
4. **The local-AI slot refuses a pooled database address.** The slot is a
   session advisory lock, which a transaction pooler cannot hold. D-127
   relied on the local database being direct. A hosted worker must be given
   the direct address; a pooled one now fails with
   `LOCAL_AI_SLOT_NEEDS_DIRECT_CONNECTION` rather than running two generations
   on one card. `LOCAL_AI_CONCURRENCY` stays 1.
5. **Cache invalidation is handed over.** The worker is not the web
   application, so `revalidateTag` there does nothing. It posts the tags to
   `/api/cron/revalidate` (CRON_SECRET; known tags only). Without it, pages
   catch up when their cache lifetime lapses.
6. **One health report** (`lib/health.ts`), at `/api/admin/health` for staff
   and `/api/cron/health` for a monitor holding CRON_SECRET. Built from the
   existing checks. The worker records what it can reach every minute; the
   web application reports that, since it cannot reach those services itself.

**Not changed.** Renderer restrictions, safeFetch, robots, SSRF rules,
English-only research, source trust and ranking, D-127's queue behaviour and
error codes, SeoPulse's writing rules, the verification policy.

**Left as follow-up.** A SeoPulse run claimed while Ollama is unreachable
finishes with rules wording at once rather than waiting for a GPU to start;
a document staff provide is read inside the web request, which cannot reach
a private Ollama, so there it is read by the structured readers only;
an on-demand GPU endpoint that is not Ollama's API needs its own provider;
R2 has no media provider (Vercel Blob is the implemented store); SMS has no
provider; account and security email is not written.

**Not verified.** No hosted environment exists. `deploy/` (the worker image,
the compose file, SearXNG's settings) has not been built or run: there is no
Docker and no cloud GPU here.

## D-134 — Staging readiness: which database, which kind of connection, a GPU apart from the worker

**Context.** D-133 made a worker and private services possible but left the
hosted environment unbuilt and three things open: nothing proved which
database a deployment would migrate, only Neon's "-pooler" host name told a
pooled address from a direct one, and the worker template put every
background job on the GPU machine. Inspecting the Vercel project (read only)
also showed that its one `DATABASE_URL` / `DATABASE_URL_UNPOOLED` pair,
`SESSION_SECRET`, `CRON_SECRET` and Blob token are each a single entry shared
by Production and Preview, and the build logs show preview builds of this
branch applying migrations 0023–0045 (0045 by `fc329eb`) while the
production deployment still runs code from migration 0022. *Corrected
later the same day:* Neon's deployment action gives every Preview
deployment its own database variables (a Neon preview branch copied from
production), and gives Production none, so those migrations ran on the
preview branch, not on production's database (docs/STAGING.md).

**Decisions.**

1. **`EXPECTED_DATABASE_NAME` pins the database.** `db/migrate.ts` (and so
   `vercel-build`) and the worker ask `current_database()` before writing
   anything and stop when it is not the expected name (`db/identity.ts`).
   Unset, nothing changes. The staging check also refuses development, test,
   scale and providers' default databases (`neondb`, `postgres`) as staging.
2. **`DATABASE_CONNECTION_MODE` (direct | session | transaction) states what
   an address is.** Only Neon names its pooler; for any other provider an
   address without "-pooler" is now `unknown`, not assumed direct. A
   declaration never overrides an address that says it is pooled.
   `transaction` turns prepared statements off and refuses the local-AI slot
   and migrations, as "-pooler" does.
3. **A real session-lock test** (`db/session-probe.ts`): one held
   connection takes an advisory lock on a fresh key; a second connection must
   be refused it; the same server process must answer throughout; the
   release must report that session held it. Failing proves a transaction
   pooler; passing is evidence, not proof (an idle pooler can pass), and is
   reported that way. The worker runs it at start whenever local AI is on and
   refuses to start on a failure; `npm run staging:check` runs it always.
4. **The worker's lane waits for the model's service** (`localAiServiceGate`,
   `LOCAL_AI_SERVICE_WAIT_MINUTES`, default 30). While Ollama is not
   answering, or answers without the model, a local-AI job is left queued
   instead of finishing with rules wording; older than the wait it runs and
   falls back exactly as before, recorded as rules with `fallbackFrom`. An
   address that is refused, or no model chosen, cannot clear by itself and
   is not waited for. Only the worker passes the gate: `/api/cron/jobs` in
   development behaves as D-127 left it. Ordinary jobs never wait.
   The D-133 follow-up asked whether finishing with rules during an outage
   was a bug: it was not — the run is recorded as rules with the outage's
   code and never as the model's — but with a CPU worker apart from the GPU
   it would have made every run during a GPU restart a rules run.
5. **The worker runs apart from the GPU** (`deploy/worker-stack.compose.yml`
   for the worker and a private SearXNG, `deploy/gpu-stack.compose.yml` for
   Ollama). A GPU that is off must not stop email, order expiry or publish
   dates. Ollama is reached over a private network (its port bound to the
   overlay address only) or through an optional Caddy gateway that answers
   only `/api/tags` and `/api/chat`, only with the bearer token, and refuses
   everything when no token of 32+ characters is set.
6. **A provided document is not sent towards a private model from a web
   request.** With `JOB_RUNNER=worker`, `provideDocument` outside the worker
   reads with the structured readers only and logs
   `pkb.extraction_not_in_web_request` (a hosted extraction provider is still
   asked). Moving that reading into a job needs a new job kind, re-reading the
   stored text without its original HTML, and deduplicating evidence against
   what the request already proposed: left as follow-up (BLOCKED_ARCHITECTURE
   for this pass), not improvised.
7. **Media stays apart even in a shared store.** `MEDIA_BLOB_PREFIX`
   (default `products`) is the only folder a Blob provider claims, reads,
   sweeps or deletes in; `delete` now refuses a key outside it. A staging
   deployment sharing production's store with `staging/products` cannot
   touch production's photographs.
8. **Refusals no longer name the host.** `localServiceUrl`'s reasons reach
   the health report, which carries no address; they now say "the address".
9. **`npm run staging:check`** (`lib/staging/*`): one role's settings
   (`--role web|worker`, `--env-file`) as READY / WARNING / MISSING, then
   read-only live checks (database identity, TLS, migrations, session lock,
   SMTP login, one SearXNG query, Ollama's model list). Never prints a value.
10. **Container health is liveness only.** `WORKER_ALIVE_FILE` is touched on
    every pass of the loop; `scripts/jobs/worker-alive.mjs` checks its age.
    It never queries the database, so a database outage does not get the
    worker restarted for nothing. The image runs under tini so the browser's
    processes are reaped.

11. **One retry on a connection reset before any answer.** `localRequest`
    (Ollama and SearXNG) sends a request once more, on a fresh connection,
    when the first fails with ECONNRESET / a closed socket: fetch reuses
    kept-alive connections that the service or its gateway may already have
    closed, and that reset was being recorded as `OLLAMA_UNAVAILABLE` and a
    rules fallback. Found as an intermittent failure of two D-127 tests in
    the full suite (the fake Ollama's idle connection reset under load);
    reproduced with a captured `read ECONNRESET` before fixing. Same time
    limit; never more than two tries; a reset after the service received a
    chat could cost one repeated generation, never a second answer kept.

**Not changed.** The job queue, claiming, retries, D-127's codes, safeFetch,
robots, the renderer's restrictions, the outbox's schedule, payment and
shipping (mock), the Vercel project's settings.

**Not verified.** No managed database, staging Blob store, SMTP account,
GPU, Docker host or Sentry project exists; see docs/STAGING.md, "External
actions".
