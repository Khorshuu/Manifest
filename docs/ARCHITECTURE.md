# Architecture

## System shape

One Next.js application serves three surfaces from one codebase and one deployment:

- **Storefront** — public, server-rendered for SEO, at `/`.
- **Account** — authenticated customer area, at `/account/*`.
- **Admin** — authenticated staff/super-admin dashboard, at `/admin/*`.

A single app was chosen over separate storefront/admin apps because both share the same domain logic, the same database, and the same auth/session mechanism — splitting them would duplicate all three for no isolation benefit at this scale. See [DECISIONS.md](DECISIONS.md) D-001.

## Layers

```
app/                    routes only: page components, layouts, route handlers
  (storefront)/         customer-facing routes
  account/               authenticated customer routes
  admin/                 authenticated staff/super-admin routes
  api/                   route handlers for webhooks and non-page mutations

components/             presentational UI, no direct data access

lib/
  auth/                 session creation/validation, password hashing, role checks
  catalog/              category tree, attribute/variant combination logic, search
  preorder/             capacity check, reservation, waitlist — the transactional core
  orders/               order creation, status transitions, idempotency
  providers/
    payment/            interface + SSLCommerz implementation + mock implementation
    shipping/           interface + courier/tracking implementation + mock implementation
    notification/       interface + email/SMS implementation + mock implementation
  audit/                write-only audit log helper, called from every admin mutation
  validation/           schema definitions (one schema per external input shape)

db/
  schema/               Drizzle table definitions, one file per domain area
  migrations/           checked-in SQL migrations, never edited after merge
```

Route handlers and server components are thin: validate input against a schema in `lib/validation`, call one function in `lib/`, shape the response. All business rules live in `lib/`, so they are unit-testable without an HTTP layer and are not duplicated between a page and an API route that both need the same rule.

## Request flow: placing a preorder

1. Client posts cart contents plus an idempotency key to a route handler.
2. Route handler validates the request shape only — no price, no capacity, no total is trusted from the client.
3. `lib/orders` opens one database transaction:
   - re-reads each variant's live price and preorder status,
   - calls `lib/preorder` to lock and check remaining capacity (`SELECT ... FOR UPDATE`),
   - increments `preorder_reserved`, inserts the order and its items at server-computed prices,
   - inserts the first `order_status_history` row (`placed`).
4. On commit, `lib/providers/payment` is called to create a payment intent; the order stays `placed` until payment confirms.
5. A payment webhook (or, for the mock provider, a direct confirmation call) transitions the order to `payment_confirmed` through `lib/orders`, which appends to `order_status_history` and triggers `lib/providers/notification`.
6. The idempotency key is stored against the resulting order id; a retried request with the same key returns the existing order instead of creating another.

This is the one flow in the system where correctness is non-negotiable (MASTER_PRODUCT_SPEC.md §7), so it is the first thing built after the schema and the first thing covered by integration tests — see [TESTING.md](TESTING.md).

## Authorization

Every route under `/admin` and every mutation checks the session's role server-side before doing anything, regardless of what the UI shows or hides. `staff_admin` and `super_admin` differ only in a short list of gated actions (managing other admins, financial/site-wide settings) checked explicitly at the point of use, not by a separate route tree. See [SECURITY.md](SECURITY.md).

## Provider abstraction

`lib/providers/payment`, `lib/providers/shipping`, and `lib/providers/notification` are interfaces. Each has a mock implementation that simulates success/failure without a network call, selected by an environment variable. This lets every flow — including checkout and order-status progression — run and be tested before SSLCommerz, a courier API, and an SMS/email provider have real credentials, per MASTER_PRODUCT_SPEC.md §7.

## Rendering strategy

- Category and product pages are server-rendered with revalidation on catalog change, for SEO and largest-contentful-paint budget.
- Cart, checkout, account, and admin pages are dynamic per request — they show per-user state and must never be cached across users.
- Client components are limited to interaction: variant selectors, quantity steppers, the admin product wizard's step navigation. They call route handlers; they never compute a price or a total themselves.

## Data access

All database access goes through `lib/` functions using Drizzle. No component or route handler imports the database client directly. This keeps the capacity-check transaction, the audit-log write, and the price-computation logic each defined exactly once.
