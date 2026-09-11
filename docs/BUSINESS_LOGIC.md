# Business Logic

Rules that must hold regardless of which screen or endpoint touches them. Each rule states the invariant, then where it's enforced.

## Pricing

- Every price a customer sees is server-computed at render time from `product_variants.price_bdt` (resolved against the product base price if `price_is_delta`). No page, component, or API response ever accepts a price from the client and trusts it.
- `cost_price_usd` and computed margin are never present in any response reachable by a `customer` session. Enforced by using separate query functions (`lib/catalog/getPublicVariant` vs `getAdminVariant`) rather than one function with a role check sprinkled inside — a missed conditional is a leak; a function that structurally cannot return the field is not.
- A cart line displays live price, not a remembered one. If the live price differs from what was true when the item was added, the cart shows the change before checkout can proceed.
- A sale is a second price with a window (`sale_price_bdt`, `sale_starts_at`, `sale_ends_at`), never an edit to `price_bdt`. Whether it is live is decided by the database's clock through the single expression in `lib/catalog/price.ts`, which every price-reading query uses: the cart, order placement, the product page, the cards, price sorting and the price facet. A query that reached for `price_bdt` directly would quietly charge the pre-sale price.
- A sale price may never exceed the regular price, and a sale may not end before it starts. Both are check constraints on the table as well as checks in `updateVariant`, which compares against whichever regular price the save leaves in place — otherwise two separate saves could walk past a check that only fired when both fields arrived together.
- The order is priced inside the transaction that places it, so a sale that ended a second earlier is not honoured and one that has just started is.
- Availability has one vocabulary — in stock, low stock, out of stock, preorder, preorder full, closed — decided by `stockState` in `lib/catalog/price.ts` and used by both the buy box and the admin. An in-stock variant with no quantity recorded is unlimited, not empty.

## Preorder capacity

- `preorder_reserved` only ever changes inside a transaction that also locks the variant row (`SELECT ... FOR UPDATE`) and re-checks `preorder_reserved + requested_quantity <= preorder_capacity` immediately before incrementing. This is the one place in the system where a race condition has a direct financial consequence (selling a slot twice), so it is never done as a read-then-write across two separate statements.
- A variant whose `preorder_closes_at` has passed, or whose remaining capacity is zero, cannot be added to a cart or checked out — checked at both add-to-cart time (for a fast UI response) and again inside the checkout transaction (as the authoritative check).
- If a variant closes or sells out while sitting in an open cart, checkout does not fail silently: the line is flagged, and the shopper is offered the waitlist for that variant.
- Cancelling a preorder order before it leaves `placed`/`payment_confirmed` releases its reserved capacity back to the variant, inside the same kind of locked transaction.

## Order lifecycle

- Status only ever moves forward through `placed → payment_confirmed → sourcing → shipped_from_us → in_bd_customs → out_for_delivery → delivered`, or sideways into `cancelled` / `refunded`. No code path writes a status "backward"; a correction is a new `order_status_history` row with a note, not a mutation of history.
- Every status change writes one `order_status_history` row with the actor (a staff `user_id`, or null for a system/webhook-driven change such as a payment confirmation). This is what the admin order screen and the customer's tracking view both read — neither reads `orders.status` alone without the history, since the history is the audit trail for "who changed this and when."
- An order reaching `payment_confirmed` is the trigger that actually reserves preorder capacity and sends the confirmation notification — not `placed`, since a placed-but-unpaid order must not hold a slot indefinitely. An order that never reaches `payment_confirmed` within a short window is cancelled and its (not-yet-reserved) capacity needs no release.
- Idempotency: order creation requires a client-supplied key, stored uniquely on `orders.idempotency_key`. A retried create with the same key returns the original order rather than raising a duplicate error to the caller — retries are expected (client timeout, double tap) and must be invisible to the shopper.

## Landed price

- A variant price is a landed price: goods, freight into Bangladesh and customs duty are already inside it, and nothing is added at checkout. The cart and the checkout summary both say "Shipping and duty: Included" rather than showing a line that later grows.
- At placement the price is split into `subtotal_bdt` (goods), `shipping_fee_bdt` and `duty_bdt`. The three always add back to exactly `total_bdt`, with rounding absorbed by duty — a breakdown that does not sum to the total is worse than none (DECISIONS.md D-010).
- Freight is priced from the variant weight and `landed.shipping_per_kg_bdt`, falling back to `landed.assumed_weight_grams` when a variant has no weight. Duty is `landed.duty_percent` of the goods value, not of the whole price.
- Freight is capped at the price itself, so a cheap heavy item can never produce a negative goods value.
- Changing the rates changes the bookkeeping and nothing else. What a shopper pays comes from the variant price alone, and a test asserts the total is identical across two different duty rates.
- Orders placed before the split existed carry zero shipping and zero duty. Those pages show a single total rather than a breakdown that would claim the whole price was goods.

## Notifications

- Every status a customer's order reaches produces exactly one message, written to the `notifications` outbox in the same transaction as the status change (DECISIONS.md D-009). Placement, payment confirmation, each shipping stage, cancellation and refund are all covered.
- A message goes to the account's email address, or to the guest email for a guest order. An order with neither queues nothing rather than failing the order.
- A message is composed from the order number, the total, and the amount actually taken now. Nothing reads `orders.internal_notes`, a refund reason, or any sourcing cost: staff wording is written for staff, and a refund message says a refund was issued without repeating why.
- Delivery is separate from queueing. A failed send marks the row `failed` with the reason and leaves it for staff on `/admin/notifications`; it never fails the order operation that queued it.
- No email or SMS provider is connected. `MockNotificationProvider` records the attempt and sends nothing, and the admin screen says so on the page, so a `sent` row is not misread as proof a customer was told.
- A scheduled sweep at `/api/cron/maintenance` delivers what is waiting, every ten minutes. Before it, delivery depended on traffic: the request that queued a message also tried to send it, so a message queued by the last order of the night waited for the first order of the morning.
- A failed message is retried by the next sweep, up to five attempts, after which it is left alone. Retrying a bad address forever costs money at a real provider and buries the failures that could still be fixed. The attempt count is on the row, so staff can see which is which.

## Deposit vs full payment

- A variant's `payment_mode` and `deposit_percent` determine `amount_due_now_bdt` at order placement: the full `total_bdt` for `payment_mode = 'full'`, or `deposit_percent` of it for `'deposit'`. This is computed once at order placement and stored, not recomputed later against a `total_bdt` that could theoretically change (it can't, since orders snapshot their totals).
- A remaining balance is collected through a second `payments` row of `kind = 'balance'`, triggered by staff from the admin order screen once the item is confirmed sourced — not automatically on a timer, since the trigger is "the operator actually bought it in the US," an external fact the system doesn't observe on its own.

## Reviews (built after Phase 15)

- A review is only creatable when a `reviews` row would reference an `order_items` row belonging to the reviewing user, on an order that has reached `delivered`. The unique constraint on `(user_id, product_id)` prevents a second review outright; the write path additionally checks order status before insert, since the constraint alone can't express "delivered."
- New reviews start `status = 'pending'` and are excluded from the public rating average and review list until a staff member approves them. Rejecting an approved review removes it from both again.
- Eligibility is decided in `lib/reviews`, not by the page. The product page renders the form only for someone whose delivered order entitles them to it, and `submitReview` re-checks the same delivered order item on submit, so a rendered form is never the thing that grants permission.
- A published review shows a first name derived from the account's email local part, never the address itself. The moderation queue shows the address, because staff need to recognise a reviewer; that queue is staff-only.
- Both moderation decisions write an `audit_log` row with the status they replaced, so a review disappearing from a product page can be explained afterwards.
- The account page invites someone to review only what was delivered to them and not yet reviewed. Asking for a review of something that never arrived is the fastest way to make the ratings worthless.

## Publishing a product

- A product reaches a shopper-visible status only through `publishProduct`, which re-runs every required readiness check before it writes. The wizard shows the same checklist, but the screen reports the rule rather than being it: a stale page, a direct API call, or a future screen that forgets to look all hit the same gate.
- Required to publish: a category, at least one photograph, at least one enabled variant, a price above zero on every variant on sale, and a capacity plus a closing date on every preorder. An uncapped preorder is the no-overselling rule waiting to be broken, and a zero price would be charged as zero.
- Advisory, and never blocking: an arrival window, a description, and a meta description. Blocking on these would teach staff to work around the gate.
- Publishing is not a way to set an arbitrary status. Only statuses shoppers can see are accepted, so `draft` and `archived` cannot be reached through it.
- A product that varies by nothing still gets one plain variant, created idempotently. Without it a simple product would have nothing to price and could never be sold.
- `publish_at` and `unpublish_at` record intent; the status is still what decides visibility, and anything acting on those dates goes through `publishProduct` and therefore through the same readiness checks. A date can never put an unfinished listing in front of a shopper.
- `seo_no_index` keeps a published listing out of search results without unpublishing it. It is a robots directive on the page, not an access control — the listing is still public, and anyone with the link can buy from it.

## The listing's own fields

- A product save is partial: a field the caller did not send keeps its stored value, and an explicit `null` clears it. This is what lets the admin editor be independent panels; it also means every clearable field must be sent as `null` rather than omitted when staff empty it.
- `products.sku` is unique across the catalogue when set, enforced by a partial unique index (many products may have none) and checked first in `assertSkuIsFree` so the admin gets a sentence naming the clash instead of a constraint violation. Variant SKUs are unique in the same way, through the column's own constraint and a check in `updateVariant`.
- Specifications defined on a category are inherited by everything filed beneath it, and are validated on the server on every save: a value belonging to another category's definition is refused, a choice that is not on the list is refused, a required one must be answered, and a blank is dropped rather than stored. Deleting a definition removes the answers stored against it, so nothing orphaned can be rendered later.
- The product page renders no section it has no content for. An empty warranty, an unfilled certification block, a listing with no lifestyle imagery and a specification with no value all produce nothing at all rather than a heading over a dash.
- Only staff may create or edit product media and listings, enforced inside `lib/catalog` rather than at the route — including the newer media actions (reordering a whole gallery at once, correcting an image's description, uploading lifestyle imagery).

## Roles and permissions

- `customer` can never create, edit, or archive a product, variant, category, or attribute, under any code path — this is checked in `lib/auth` at the top of every mutating function in `lib/catalog`, not only at the route layer, so a future route that forgets the check still can't succeed.
- `staff_admin` and `super_admin` share most admin capability. The specific `super_admin`-only actions are: managing other admin accounts (creating, role-changing, deactivating), editing `site_settings`, and viewing financial/margin reports. Each of these checks `role === 'super_admin'` explicitly at the point of use.
- Every admin mutation (product, variant, category, attribute, order status, site setting, user role) writes one `audit_log` row with the actor, the action, and before/after values, in the same transaction as the mutation itself — not as a best-effort side effect after commit, since an audit entry that can silently fail to write is not an audit trail.

## Dashboard numbers

- Every figure on the admin dashboard (revenue, pending preorders, low-capacity alerts, top products) is a live query against `orders`, `order_items`, and `product_variants` — never a cached snapshot presented as current, and never a placeholder value during development. If a metric can't be computed correctly yet, the dashboard states that explicitly rather than showing a plausible-looking number.

## Browsing and filtering

- The listing, the count above it, and the facet counts are all built from one `ProductFilters` value through `buildProductWhere`. A count computed from different conditions than the list it labels is worse than no count at all.
- Values of one attribute are OR-ed and different attributes are AND-ed. Ticking a second colour should widen the results; ticking a size as well should narrow them. Any other combination surprises people.
- Facet counts exclude the facet's own selections, so an unticked value shows what it would add rather than always reading zero.
- Price is filtered against variant prices, not a product-level field, because the price a shopper sees on a card is the lowest purchasable variant.
- "Only what can be bought now" mirrors what the product page decides: stock remaining, or a preorder slot left with the window still open. A listing must not offer what the detail page then refuses.
- Filters live in the URL and the panel is an ordinary GET form. A filtered listing can be linked and shared, and it works before any JavaScript has loaded.
- Autosuggest returns labels, links, a product photograph and the price a shopper would pay (D-028) — never stock or cost — and every source it draws on (products, their words, tags, categories, popular searches) goes through the public predicate, so it cannot surface a draft or a product hidden from search.

## Search (D-026 to D-030)

- What is searched: name, brand, SKU and trade identifiers, model and part numbers, variant SKUs, search keywords, the category and every shelf above it, highlights, live variant option values, searchable category specifications, material/colour/size/compatibility details, description, spec table, box contents, tags and meta description. Nothing internal: no cost, no notes, no supplier data.
- Visibility is decided at query time, never by the index: a draft, archived, or hidden-from-search product cannot appear however stale its index row.
- "Hidden from search" hides a listing from the search box and its suggestions only; its page, its category listings and the cart are unaffected. Category pages list it.
- Every word must match (a second word narrows). A word matches as a prefix, through stemming, through a staff synonym, or inside a word of the name.
- Ranking is a relevance tier first (D-027). The staff boost, sales, ratings, availability and recency only reorder within a tier.
- A correction is only tried when the search as typed found nothing, only applied if it finds something, and always announced with a way to search exactly what was typed.
- Synonyms are written by staff only; nothing is generated. One-way entries widen only the first term.
- A search that finds nothing shows advice, a correction if confident, and what each of its words finds alone — never unrelated products.
- Sort options are offered only when the data supports them: best selling needs a paid order, customer rating an approved review, biggest discount a live sale.
- Attribute filters appear only when the current results carry at least two values of the attribute (or one is selected). Values of one attribute are OR-ed, different attributes AND-ed; a variation attribute and a specification with the same name are one filter (D-030).
- A price filter needs one variant inside the whole range, not one variant above the minimum and another below the maximum.
- Search result pages are `noindex, follow`; filtered, sorted or paged category pages are too, with the canonical on the plain category.
- A chip removing a filter is an ordinary link back to the same listing with that parameter dropped, and it drops the page number with it: the results are about to change, so page three may no longer exist. Removing a filter never removes the search — someone clearing a brand did not ask to be sent back to the whole catalogue.
- Search matches everything a listing says about itself (title, brand, description with markup stripped, bullet points, spec table, tags, meta description) plus its category's name and its variants' attribute values. Ranking prefers a title match to a mention in a paragraph, because that is what shoppers mean. See DECISIONS.md D-018.
- A recommendation is scored against what the catalogue records — a relationship staff stated, the shelf, a shared tag, the brand, a comparable price — and anything scoring zero is not a recommendation. A short row is topped up with the best-rated products, never with a random draw. See D-019.

## The homepage (D-035)

- The first screen is a promotional slider of up to five campaigns. A campaign is one record: a hero photograph (about 87% of the viewport on desktop) and the four showcase tiles under it. Arrows, swipe, the arrow keys and the dots move the whole unit; the hero can never change without its tiles.
- Only a slot switched on with a hero image is shown. Switching on a slot or tile without an image is refused, and removing a hero switches its slot off, so the storefront never shows a blank slide or an empty card.
- A tile is an image and a custom title, nothing else — no price, stock or product data. Its image is its own upload, not a product photograph.
- The hero, the button and each tile may link anywhere on this site (a path) or to an absolute http(s) address. Anything else is refused on save. "New tab" applies only to off-site links, always with `noopener`.
- Images are uploads, never URLs. A replaced or removed file is deleted once nothing else in the campaigns points at it; a borrowed product photograph (carried over from the old showcase) is never deleted.
- The header's treatment follows the slide in view: Automatic measures the photograph; staff can force light or dark lettering per slide.
- With every slot switched off the page builds a temporary slide from the catalogue rather than showing nothing. It is never stored.
- The page's `h1` is visually hidden; a slide's optional headline is an `h2`.

## Customer spend

- "Spent" on Admin → Customers is the sum of `total_bdt` over the customer's orders in a paid status (`payment_confirmed` through `delivered`). Unpaid (`placed`), cancelled and refunded orders count as orders but not as spend. The dashboard's sales figure uses the same statuses, so the two cannot disagree.
- It is computed on read from `orders`, never stored, so a status change is reflected immediately and nothing can double count.

## Staff roles (D-034)

- Each staff role is a named list of permissions in `lib/auth/authorize.ts`. Every admin function asks for one permission; every admin page checks the same permission before rendering; the navigation shows only what the role holds. Hiding a link is never the control.
- Money (sales, average order, revenue per day, margin export) is computed only for `finance.view`. Other roles see counts.
- Only the owner (`super_admin`) manages staff and site settings. Nobody can change their own role, and the last owner cannot be demoted.
- Staff temporary passwords need at least 8 characters; customer passwords 10.

## Variation engine (Phase 5)

- Combinations are the Cartesian product of the attributes a product varies by. An attribute with no values makes the product empty rather than being skipped — a variant that does not specify one of the product's own axes would be meaningless.
- Generation is capped at 500 combinations. This is a guard, not a limit anyone should reach: five axes of five values is already 3,125 variants, which no admin UI can present usefully, and generating tens of thousands by accident is far worse than an error message.
- Regeneration only adds what is missing. Existing variants are never updated or deleted: they carry prices and preorder capacity, and they can be referenced by orders.
- A combination that no longer exists — because an attribute was dropped from the product, or a value removed — is reported as orphaned, never deleted. Deleting it would erase what a past order actually bought. The database enforces the same thing from below: an attribute value a variant references cannot be deleted.
- Taking a combination off sale is done by disabling it. The row stays, so an order that referenced it still resolves; only `isEnabled` variants are purchasable.
- Preorder capacity can never be set below the number of slots already reserved. Those slots are sold, and lowering the ceiling underneath them would mean the site has taken more preorders than it can fulfil.
- Price and capacity changes are recorded as their own audit actions (`product.price_changed`, `variant.capacity_changed`), because MASTER_PRODUCT_SPEC.md section 4 names them as the sensitive ones. A bulk edit writes one audit row per variant, not one for the batch.

## Account: wishlist, addresses, newsletter (gap audit pass)

- A wishlist row is a variant and an account, never a price. Its price and availability are read live, the same way the cart reads them.
- "Save for later" moves a cart line onto the wishlist in one transaction. "Move to cart" adds one of the item through the cart's normal availability check and only then removes it from the list; if the cart refuses, it stays saved.
- An address any order has used is never rewritten or deleted: an edit writes a new row and detaches the old one, a removal detaches it (DECISIONS.md D-032). An account keeps at most ten addresses and always has exactly one default while it has any.
- Newsletter signup is idempotent by lowercase address; nothing is sent until an email provider is connected.
- Coupons and zone-based delivery charges do not exist; the landed price is still the whole price (D-033).

## Product SKUs (D-037)

- A SKU is generated on the server when Add Product opens and held for that admin (two hours, renewed on reopening). Nobody else can be given it while held.
- Saving the product makes the SKU permanent in the same transaction; a permanent SKU is never generated again, even if the product is archived or its SKU is later changed.
- Cancelling the form, or letting the hold expire, releases the SKU; the lowest free number is generated next, so released SKUs are reused.
- A typed SKU is checked against products, variants, other admins' holds and every permanent SKU. A failed save leaves the hold in place so a retry keeps the same SKU.
- Only roles with `catalog.manage` can reserve or release, and only their own holds.

## SEO Pulse (D-038)

- Research runs only when staff press the button. It uses the product as saved; nothing has to be filled in first.
- A run collects: this site's own search log (always), external keyword and search-results data (only if a provider is configured), then writes recommendations (rules by default, Claude if configured). A failed provider is recorded and the rest carry on.
- Search volume, difficulty, competition, CPC, trends, rankings and competitor pages are shown only when a source returned them, with the source and date. Otherwise they read "Data unavailable". Nothing is estimated.
- Recommendations are labelled with what wrote them: "AI-generated" or "Rule-based", and "external research unavailable" when no external data was collected.
- Scores: the SEO Pulse Optimization Score and the Internal Search Score are weighted completeness checks of the listing as saved now (`lib/seo-pulse/scores.ts`). They are not Google scores and promise no ranking.
- Every run is kept as a numbered version. "Run fresh research" adds a version; it never replaces one. An unchanged product reuses research under 30 days old unless fresh research is asked for. Research older than 30 days, or for a product that has changed since, is flagged "Needs refresh".
- Applying: an empty field can be filled directly; a field with a value needs an explicit Replace, confirmed on screen and checked again on the server. Lists can be added to freely; removing an entry needs Replace. The address and the product name are never selected by default.
- Applying never publishes, prices, stocks, re-files, archives or deletes anything. Photograph alt text written by SEO Pulse is marked "Needs manual review" because SEO Pulse cannot see the image.
- Synonyms become a site-wide entry only when ticked, only for staff with `search.manage`, and an existing entry for the same term is never changed.
- Downloads: JSON (everything), CSV (one row per finding, with `data_type` research/analysis) and a readable HTML report.
