# Security

## Authentication

- Passwords hashed with argon2id. No password, hash salt, or reset token is ever logged.
- Sessions are opaque tokens in `sessions`, referenced by a signed, HTTP-only, `Secure`, `SameSite=Lax` cookie. No JWT holding role or identity claims client-side — every request re-reads the session row, so revoking a session (logout everywhere, role change) takes effect immediately rather than waiting for a token to expire.
- Password reset tokens are single-use, expire in one hour, and are invalidated the moment they're used or a new one is issued.
- Login and password-reset endpoints are rate-limited per IP and per account.

## Authorization

- Every mutating route handler and every `lib/` function that touches `products`, `product_variants`, `categories`, `attributes`, `orders`, `users`, or `site_settings` checks the caller's role before doing anything else. This check lives in the function, not only in middleware or in the route — so calling the function directly from another context (a script, a future route) can't bypass it.
- `customer` role is never sufficient for any product/listing/media mutation, under any circumstance (MASTER_PRODUCT_SPEC.md: business model statement). This is treated as a hard invariant, tested explicitly rather than inferred from "no route exposes it."
- `staff_admin` vs `super_admin` differences (admin management, site settings, financial reports) are enumerated in [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md) and checked explicitly, not derived from a permissions table.
- Ownership checks (a customer viewing their own order, address, or review) compare the session's `user_id` against the row's owning `user_id` server-side on every read of account-scoped data — never inferred from a client-supplied id alone.

## Input handling

- Every external input (form submission, route handler body, webhook payload) is validated against a schema in `lib/validation` before touching any business logic. Unknown fields are rejected, not silently dropped-and-ignored, so a client sending an unexpected `price` or `role` field fails loudly instead of being quietly ignored in a way that could mask a bug later.
- Price, total, discount, capacity, and role are never read from client input for any computation — they are always re-derived server-side from the database, per [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md).
- File uploads (product images) are validated by content-type sniffing (not filename extension alone) and size limit, filenames are regenerated (never trusting the client's filename), and no executable or script-bearing file type is accepted. Uploaded images are re-encoded to a fixed set of output sizes rather than served as-uploaded.

## Payments

- No card number, CVV, or wallet credential ever reaches the application server — SSLCommerz's hosted flow collects them directly. The application only ever holds a `provider_ref` and a status.
- Payment webhooks verify the provider's signature before any order-status mutation is applied, and are idempotent on the provider's event id — a replayed or duplicated webhook call must not double-confirm a payment or double-release capacity.
- Refunds are issued through the same provider abstraction and always produce a `payments` row of `kind = 'refund'`, never a silent balance adjustment on the order alone.

## Data protection

- Secrets (database URL, SSLCommerz keys, session signing key, SMS/email provider keys) live in environment variables, never committed, documented by name (not value) in `.env.example`.
- `cost_price_usd`, computed margins, and internal admin notes are excluded at the query layer from any function that serves a customer-facing response — see [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md) pricing section.
- Business-critical records (`products`, `product_variants`, `orders`, `users`) are soft-deleted (`archived_at`), never hard-deleted, so an order placed against an archived product still resolves correctly in order history.
- A user's personal data can be anonymized on request (name, email, phone, address text replaced) while the `orders` and `payments` rows that reference them are retained, satisfying deletion requests without breaking financial record-keeping obligations.

## Audit

- Every admin mutation writes an `audit_log` row (actor, action, entity, before/after) in the same transaction as the change, per [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md). `audit_log` itself is insert-only from application code — no update or delete path exists for it.

## Transport and headers

- HTTPS enforced at the hosting layer; the app assumes it is always served over TLS and sets `Secure` on all cookies accordingly.
- Standard security headers (`Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`) are set at the framework/edge config level, not per-route.

## Open questions

- Does the business need 2FA for `super_admin`/`staff_admin` accounts at launch, given they can move money (refunds) and change prices? Recommended yes; not yet confirmed.
- What is the data retention period required for order records under applicable Bangladeshi law, which sets the floor for how long anonymization can be deferred?
