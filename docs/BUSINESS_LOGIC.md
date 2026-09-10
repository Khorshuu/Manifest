# Business Logic

Rules that must hold regardless of which screen or endpoint touches them. Each rule states the invariant, then where it's enforced.

## Pricing

- Every price a customer sees is server-computed at render time from `product_variants.price_bdt` (resolved against the product base price if `price_is_delta`). No page, component, or API response ever accepts a price from the client and trusts it.
- `cost_price_usd` and computed margin are never present in any response reachable by a `customer` session. Enforced by using separate query functions (`lib/catalog/getPublicVariant` vs `getAdminVariant`) rather than one function with a role check sprinkled inside — a missed conditional is a leak; a function that structurally cannot return the field is not.
- A cart line displays live price, not a remembered one. If the live price differs from what was true when the item was added, the cart shows the change before checkout can proceed.

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
- Autosuggest returns labels, links and a product photograph — never price or stock — and goes through the same public predicate as every other shopper query, so it cannot surface a draft.
- A chip removing a filter is an ordinary link back to the same listing with that parameter dropped, and it drops the page number with it: the results are about to change, so page three may no longer exist. Removing a filter never removes the search — someone clearing a brand did not ask to be sent back to the whole catalogue.
- Search matches everything a listing says about itself (title, brand, description with markup stripped, bullet points, spec table, tags, meta description) plus its category's name and its variants' attribute values. Ranking prefers a title match to a mention in a paragraph, because that is what shoppers mean. See DECISIONS.md D-018.
- A recommendation is scored against what the catalogue records — a relationship staff stated, the shelf, a shared tag, the brand, a comparable price — and anything scoring zero is not a recommendation. A short row is topped up with the best-rated products, never with a random draw. See D-019.

## The homepage

- The hero is a photograph and nothing else. No headline, no paragraph, no price panel and no button are drawn over it (DECISIONS.md D-021), so the only thing a shopper reads on the first screen is the header.
- The photograph, its focal point and the header's contrast mode are staff-owned settings, not source. Staff may write them; the storefront reads them with no session.
- The hero image is set by uploading a file, never by posting a URL, so the front page cannot be pointed at an address off this site.
- The four products beneath it are a list of slugs staff choose and order. Each is resolved through the public predicate at render time, so a product unpublished after being chosen drops out of the row rather than breaking it.
- Staff choices lead the row and the catalogue fills the rest — whatever closes soonest, then the newest — so the row is always four and never has holes in it.
- A card shows the product's own main photograph. Changing what a card shows is done on the product, with "Make main" in its Photographs section; the homepage never holds a second copy of an image.
- The page's `h1` is visually hidden. A page needs one heading, and with the words off the photograph it belongs in the markup rather than on the picture.

## Variation engine (Phase 5)

- Combinations are the Cartesian product of the attributes a product varies by. An attribute with no values makes the product empty rather than being skipped — a variant that does not specify one of the product's own axes would be meaningless.
- Generation is capped at 500 combinations. This is a guard, not a limit anyone should reach: five axes of five values is already 3,125 variants, which no admin UI can present usefully, and generating tens of thousands by accident is far worse than an error message.
- Regeneration only adds what is missing. Existing variants are never updated or deleted: they carry prices and preorder capacity, and they can be referenced by orders.
- A combination that no longer exists — because an attribute was dropped from the product, or a value removed — is reported as orphaned, never deleted. Deleting it would erase what a past order actually bought. The database enforces the same thing from below: an attribute value a variant references cannot be deleted.
- Taking a combination off sale is done by disabling it. The row stays, so an order that referenced it still resolves; only `isEnabled` variants are purchasable.
- Preorder capacity can never be set below the number of slots already reserved. Those slots are sold, and lowering the ceiling underneath them would mean the site has taken more preorders than it can fulfil.
- Price and capacity changes are recorded as their own audit actions (`product.price_changed`, `variant.capacity_changed`), because MASTER_PRODUCT_SPEC.md section 4 names them as the sensitive ones. A bulk edit writes one audit row per variant, not one for the batch.
