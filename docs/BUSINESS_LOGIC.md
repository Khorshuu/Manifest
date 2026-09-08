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

## Notifications

- Every status a customer's order reaches produces exactly one message, written to the `notifications` outbox in the same transaction as the status change (DECISIONS.md D-009). Placement, payment confirmation, each shipping stage, cancellation and refund are all covered.
- A message goes to the account's email address, or to the guest email for a guest order. An order with neither queues nothing rather than failing the order.
- A message is composed from the order number, the total, and the amount actually taken now. Nothing reads `orders.internal_notes`, a refund reason, or any sourcing cost: staff wording is written for staff, and a refund message says a refund was issued without repeating why.
- Delivery is separate from queueing. A failed send marks the row `failed` with the reason and leaves it for staff on `/admin/notifications`; it never fails the order operation that queued it.
- No email or SMS provider is connected. `MockNotificationProvider` records the attempt and sends nothing, and the admin screen says so on the page, so a `sent` row is not misread as proof a customer was told.

## Deposit vs full payment

- A variant's `payment_mode` and `deposit_percent` determine `amount_due_now_bdt` at order placement: the full `total_bdt` for `payment_mode = 'full'`, or `deposit_percent` of it for `'deposit'`. This is computed once at order placement and stored, not recomputed later against a `total_bdt` that could theoretically change (it can't, since orders snapshot their totals).
- A remaining balance is collected through a second `payments` row of `kind = 'balance'`, triggered by staff from the admin order screen once the item is confirmed sourced — not automatically on a timer, since the trigger is "the operator actually bought it in the US," an external fact the system doesn't observe on its own.

## Reviews

- A review is only creatable when a `reviews` row would reference an `order_items` row belonging to the reviewing user, on an order that has reached `delivered`. The unique constraint on `(user_id, product_id)` prevents a second review outright; the write path additionally checks order status before insert, since the constraint alone can't express "delivered."
- New reviews start `status = 'pending'` and are excluded from the public rating average and review list until a staff member approves them.

## Roles and permissions

- `customer` can never create, edit, or archive a product, variant, category, or attribute, under any code path — this is checked in `lib/auth` at the top of every mutating function in `lib/catalog`, not only at the route layer, so a future route that forgets the check still can't succeed.
- `staff_admin` and `super_admin` share most admin capability. The specific `super_admin`-only actions are: managing other admin accounts (creating, role-changing, deactivating), editing `site_settings`, and viewing financial/margin reports. Each of these checks `role === 'super_admin'` explicitly at the point of use.
- Every admin mutation (product, variant, category, attribute, order status, site setting, user role) writes one `audit_log` row with the actor, the action, and before/after values, in the same transaction as the mutation itself — not as a best-effort side effect after commit, since an audit entry that can silently fail to write is not an audit trail.

## Dashboard numbers

- Every figure on the admin dashboard (revenue, pending preorders, low-capacity alerts, top products) is a live query against `orders`, `order_items`, and `product_variants` — never a cached snapshot presented as current, and never a placeholder value during development. If a metric can't be computed correctly yet, the dashboard states that explicitly rather than showing a plausible-looking number.

## Variation engine (Phase 5)

- Combinations are the Cartesian product of the attributes a product varies by. An attribute with no values makes the product empty rather than being skipped — a variant that does not specify one of the product's own axes would be meaningless.
- Generation is capped at 500 combinations. This is a guard, not a limit anyone should reach: five axes of five values is already 3,125 variants, which no admin UI can present usefully, and generating tens of thousands by accident is far worse than an error message.
- Regeneration only adds what is missing. Existing variants are never updated or deleted: they carry prices and preorder capacity, and they can be referenced by orders.
- A combination that no longer exists — because an attribute was dropped from the product, or a value removed — is reported as orphaned, never deleted. Deleting it would erase what a past order actually bought. The database enforces the same thing from below: an attribute value a variant references cannot be deleted.
- Taking a combination off sale is done by disabling it. The row stays, so an order that referenced it still resolves; only `isEnabled` variants are purchasable.
- Preorder capacity can never be set below the number of slots already reserved. Those slots are sold, and lowering the ceiling underneath them would mean the site has taken more preorders than it can fulfil.
- Price and capacity changes are recorded as their own audit actions (`product.price_changed`, `variant.capacity_changed`), because MASTER_PRODUCT_SPEC.md section 4 names them as the sensitive ones. A bulk edit writes one audit row per variant, not one for the batch.
