# Security

## Authentication

- Passwords hashed with argon2id. No password, hash salt, or reset token is ever logged.
- Sessions are opaque tokens in `sessions`, referenced by a signed, HTTP-only, `Secure`, `SameSite=Lax` cookie. No JWT holding role or identity claims client-side — every request re-reads the session row, so revoking a session (logout everywhere, role change) takes effect immediately rather than waiting for a token to expire.
- Password reset tokens are single-use, expire in one hour, and are invalidated the moment they're used or a new one is issued.
- Login and password-reset endpoints are rate-limited per IP and per account.

## Two-factor authentication

Any account may turn it on at `/account/security`; the page recommends it in as many words to staff and super admins, because those accounts can change prices, issue refunds, and read every customer's address.

- TOTP (RFC 6238), implemented in `lib/auth/totp.ts` rather than pulled in. It is sixty lines of specified arithmetic with published test vectors, which `tests/totp.test.ts` checks against — the RFC 4226 and RFC 6238 numbers, not "it worked with my phone". No secret leaves the process, and the authentication path gains no transitive dependency.
- A secret is stored the moment enrolment starts but does nothing until a code proves it works. Enabling on generation would lock someone out of their own account whenever a QR code failed to scan.
- The password alone produces a **pending session**: a real row, with the cookie set, that `validateSessionToken` refuses. One check keeps a half-finished sign-in out of every page and endpoint, rather than each of them remembering to look. It expires in ten minutes rather than thirty days.
- A code cannot be used twice. The step it belonged to is recorded and anything at or before it is refused, so a code read over someone's shoulder is worthless the moment it is spent.
- Ten single-use recovery codes are issued once, at confirmation, and stored as SHA-256. They are high-entropy random strings, so a fast hash is right here in a way it never is for a password. They cannot be read back — if they could, a borrowed session would defeat the second factor entirely.
- Turning it off needs a current code or a recovery code, not merely a live session. Otherwise an unlocked laptop removes the protection that exists for exactly that case.
- Second-factor attempts are rate limited per account and per address, ten per fifteen minutes; exhausting them destroys the pending session rather than leaving it open to retry. Six digits are guessable at scale if the attempts are not capped.
- Both enabling and disabling are written to the audit log.

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

- Should two-factor authentication be *mandatory* for `super_admin` and `staff_admin`, rather than available and recommended? It is built and any account can turn it on (see below); making it compulsory is a business decision, because it means an admin who loses both their phone and their recovery codes needs someone with database access to get back in.
- What is the data retention period required for order records under applicable Bangladeshi law, which sets the floor for how long anonymization can be deferred?

## Implementation notes (Phase 3)

- Session tokens are 32 random bytes, base64url-encoded, sent in the cookie. The `sessions` table stores only their SHA-256, so a leaked database backup contains nothing replayable.
- Sign-in failures are indistinguishable: an unknown email and a wrong password produce the same message, and an unknown email is still verified against a dummy hash so the two paths take comparable time.
- Login is rate limited per account (10 attempts per 15 minutes) and per IP (60). The per-IP ceiling is deliberately high because offices, campuses, and mobile carriers put many legitimate users behind one address; the per-account limit is the meaningful one. The count lives in the `rate_limit_hits` table, so every process and every serverless instance shares one window: the limit holds across a deploy and cannot be sidestepped by spreading attempts. Each attempt is one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so two simultaneous requests for the last slot cannot both be allowed — proved against a real server in `tests/rate-limit-concurrency.test.ts`, and confirmed to fail when the increment is made non-atomic (20 of 20 allowed instead of 1).

Keys are stored as a SHA-256 hash, never the email or address itself: a table recording who tried to sign in and when is worth less to anyone who reaches it if it names nobody. Nothing reads a key back, so hashing costs nothing.

The limiter fails open if the database will not answer. Signing in needs the database anyway, so a database that cannot count attempts cannot check a password either — refusing there would turn an outage into a lockout while protecting nothing.
- Self-registration always creates a `customer`. The route's schema rejects unknown fields, so a client-supplied `role` fails the request rather than being ignored.
