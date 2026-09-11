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
- The one deliberate exception inside `site_settings` is the homepage hero (`home.hero`), which any staff member may write. It is content and media rather than money, and it is the same bar as uploading product photography; every other setting stays super-admin only (DECISIONS.md D-020). Two inputs on it are treated as untrusted even though only staff can send them: the call-to-action link is validated as an internal path, so the front page cannot become an open redirect, and the hero image is set by uploading a file rather than by posting a URL, so it cannot be pointed off-site.
- Ownership checks (a customer viewing their own order, address, or review) compare the session's `user_id` against the row's owning `user_id` server-side on every read of account-scoped data — never inferred from a client-supplied id alone.

## Input handling

- Every external input (form submission, route handler body, webhook payload) is validated against a schema in `lib/validation` before touching any business logic. Unknown fields are rejected, not silently dropped-and-ignored, so a client sending an unexpected `price` or `role` field fails loudly instead of being quietly ignored in a way that could mask a bug later.
- Search input is cleaned (control characters removed, 100 characters, 8 words) and reduced to letters and digits before it reaches a tsquery, so no tsquery operator can arrive from a search box; every value is a bound parameter. Filter parameters are validated and bounded (12 attribute keys, 20 values each, prices capped, page capped at 100), and an attribute key is only used if it names a real attribute. The suggest and click endpoints have a per-visitor in-memory throttle.
- Search analytics store no account id and no address: a daily-rotating HMAC of connection and browser keyed with `SESSION_SECRET`. Email- or phone-shaped searches are never stored. A query is shown to other shoppers only after three distinct visitors ran it (DECISIONS.md D-029). A customer's search history is readable and clearable only by them and is deleted on anonymisation.
- Synonyms, search visibility, search priority and index rebuilds are staff-only in `lib/`, audited, and rejected for customers at the API.
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

- ~~Should two-factor authentication be mandatory for `super_admin` and `staff_admin`?~~ **Decided: no.** It stays available and recommended, and any account may turn it on. Compulsory would mean an admin who loses both their phone and their recovery codes needs someone with database access to get back in, and the business does not want that failure mode. Revisit if an admin account is ever compromised, or if a payment processor requires it.
- ~~What is the data retention period required for order records under applicable Bangladeshi law, which sets the floor for how long anonymization can be deferred?~~ **Decided: there is none.** The product owner chose to keep customer records indefinitely, so nothing is anonymised on age and no sweep exists to need a period (DECISIONS.md D-013). `anonymiseCustomer` stays for a customer who asks to be forgotten — that is a request to comply with, not a retention policy. The trade is that the longer personal data is held the more there is to lose in a breach, which raises the value of the controls above and makes an encrypted-at-rest database matter more when this is deployed for real.

## Implementation notes (Phase 3)

- Session tokens are 32 random bytes, base64url-encoded, sent in the cookie. The `sessions` table stores only their SHA-256, so a leaked database backup contains nothing replayable.
- Sign-in failures are indistinguishable: an unknown email and a wrong password produce the same message, and an unknown email is still verified against a dummy hash so the two paths take comparable time.
- Login is rate limited per account (10 attempts per 15 minutes) and per IP (60). The per-IP ceiling is deliberately high because offices, campuses, and mobile carriers put many legitimate users behind one address; the per-account limit is the meaningful one. The count lives in the `rate_limit_hits` table, so every process and every serverless instance shares one window: the limit holds across a deploy and cannot be sidestepped by spreading attempts. Each attempt is one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so two simultaneous requests for the last slot cannot both be allowed — proved against a real server in `tests/rate-limit-concurrency.test.ts`, and confirmed to fail when the increment is made non-atomic (20 of 20 allowed instead of 1).

Keys are stored as a SHA-256 hash, never the email or address itself: a table recording who tried to sign in and when is worth less to anyone who reaches it if it names nobody. Nothing reads a key back, so hashing costs nothing.

The limiter fails open if the database will not answer. Signing in needs the database anyway, so a database that cannot count attempts cannot check a password either — refusing there would turn an outage into a lockout while protecting nothing.
- Self-registration always creates a `customer`. The route's schema rejects unknown fields, so a client-supplied `role` fails the request rather than being ignored.

## Account features (gap audit pass)

- Wishlist, save-for-later and address routes take identifiers only and act on
  the signed-in account's own rows; every query is scoped by `user_id` (or by
  the cart id the server resolved), so an id from another account matches
  nothing. Another account's address answers 404, not 403, so ids cannot be
  probed.
- The newsletter endpoint is public: rate limited per IP (20 an hour) in the
  shared store, and answers identically whether or not an address was already
  subscribed, so it cannot be used to test which emails exist.
- The recently-viewed cookie holds product ids only; ids are validated as
  UUIDs and resolved through the public predicate, so a tampered cookie can
  show nothing that is not already public.
- `/admin/customers` and `listCustomersWithOrders` are super-admin only: the
  page redirects anyone else and the query refuses them independently.

## Staff roles and permissions (D-034)

- Seven staff roles map to named permissions in `lib/auth/authorize.ts`.
  `requirePermission` is called at the top of every gated `lib/` function, so a
  route or page that forgets its own check still cannot act. Admin pages also
  call `requireAdminPage(permission)` and redirect a role that lacks it.
- `requireOwnerOrStaff` now admits staff only with `orders.view`; a product
  manager cannot read another customer's order.
- Financial figures are not computed for roles without `finance.view` — they
  are absent from the response, not hidden in the UI.
- Staff temporary password minimum is 8 (argon2id, login rate limiting and the
  staff second-factor prompt unchanged).

## Homepage campaign links (D-035)

- Every staff-entered destination is normalised server-side: a site path
  (`/…`, not `//…`) or an absolute `http(s)` URL. `javascript:`, `data:` and
  protocol-relative values are refused before storage. Off-site links render
  with `rel="noopener"` (and `noreferrer` with a new tab).
- Campaign images are uploads validated by the media provider from their
  bytes; no URL can be supplied.

## SKU reservations (D-037)

- Generation and reservation are server-only (`lib/catalog/sku.ts`); the
  browser holds just a reservation id and cannot claim a named SKU.
- `catalog.manage` is required to reserve, release or finalize; renewing or
  releasing a hold also requires being the admin who holds it.
- Audit log: `sku.reserved`, `sku.released`, `sku.finalized`.

## SEO Pulse (D-038)

- Every `lib/seo-pulse` entry point calls `requirePermission(…,
  "catalog.manage")` itself: running research, reading a run or history,
  exporting, and applying. Creating a site-wide synonym also needs
  `search.manage`. The routes (`/api/admin/products/[id]/seo-pulse`,
  `…/apply`, `/api/admin/seo-pulse/runs/[id]`, `…/export`) add nothing to
  that — a customer, an anonymous caller or a role without catalogue access is
  refused in `lib/`.
- Provider credentials (`ANTHROPIC_API_KEY`, `DATAFORSEO_LOGIN`,
  `DATAFORSEO_PASSWORD`) are read only on the server. The admin screens show
  whether a provider is configured, never the value. Provider responses are
  stored on the run and only served to `catalog.manage`.
- AI output is untrusted input: cleaned, cut to length, stripped of image ids
  that belong to other products, and parsed against a strict schema before it
  is stored; suggested description HTML is reduced to a short allow-list of
  text tags before it is stored and again before it is applied.
- Applying cannot overwrite a non-empty field unless the request names it,
  cannot change price, stock, status, category or publication, and only
  writes photographs that belong to the product.
- CSV export neutralises cells starting with `=`, `+`, `-` or `@`
  (spreadsheet formula injection). Exports are `no-store`.
- Audit log: `seo_pulse.researched`, `seo_pulse.applied`, plus the usual
  `product.updated` from the save itself.

## Signing in with Google (D-042)

- The flow is authorization code with PKCE. The `state` and the code verifier
  are held in http-only, `SameSite=Lax` cookies for ten minutes and are
  deleted the moment the callback runs, whatever its outcome. A callback whose
  `state` does not match the cookie — compared in constant time — is refused
  and nothing is signed in.
- The redirect URI is built from the site's own configured origin, never from
  a request header, so it cannot be pointed elsewhere by a crafted request.
- Only a *verified* Google address is matched to an existing account. An
  unverified one is refused and creates nothing.
- Accounts are matched on Google's subject identifier, not the email address.
- Google is not a second factor and does not replace one: an account with TOTP
  gets a pending session, which authenticates nothing until the code is proved.
- An account with no password (Google only) is refused by the password path
  with the same message, and the same argon2 cost, as a wrong password — so the
  response cannot be used to learn how an account signs in.
- Nothing Google returns is rendered. The callback redirects to `/login` with
  one of four fixed keys, and the page maps those to its own wording.
- Sign-in with Google is unavailable unless both credentials are configured:
  the button is not rendered and both routes answer 404.
