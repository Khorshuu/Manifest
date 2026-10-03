# Security

## Authentication

- Passwords hashed with argon2id. No password or hash is ever logged.
- Sessions are opaque random tokens (32 bytes) held in an HTTP-only, `SameSite=Lax` cookie, `Secure` in production; the `sessions` table stores only their SHA-256. The cookie is not signed — it needs no signature, because it carries no claims, only a random token that means nothing without the row. No JWT holding role or identity claims client-side — every request re-reads the session row, so revoking a session (logout everywhere, role change) takes effect immediately rather than waiting for a token to expire.
- **Password reset is not built.** A customer who forgets their password can sign in with Google if their account uses a verified Google address; otherwise staff must help. When it is built, tokens should be single-use, short-lived and rate limited like sign-in (PRODUCTION-READINESS 20.1).
- Sign-in is rate limited per IP and per account (see Implementation notes below).

## Two-factor authentication

Any account may turn it on at `/account/security`; the page recommends it in as many words to staff and super admins, because those accounts can change prices, issue refunds, and read every customer's address.

- TOTP (RFC 6238), implemented in `lib/auth/totp.ts` rather than pulled in. It is sixty lines of specified arithmetic with published test vectors, which `tests/totp.test.ts` checks against — the RFC 4226 and RFC 6238 numbers, not "it worked with my phone". No secret leaves the process, and the authentication path gains no transitive dependency.
- A secret is stored the moment enrolment starts but does nothing until a code proves it works. Enabling on generation would lock someone out of their own account whenever a QR code failed to scan.
- The password alone produces a **pending session**: a real row, with the cookie set, that `validateSessionToken` refuses. One check keeps a half-finished sign-in out of every page and endpoint, rather than each of them remembering to look. It expires in ten minutes rather than thirty days.
- A code cannot be used twice. The step it belonged to is recorded and anything at or before it is refused, so a code read over someone's shoulder is worthless the moment it is spent.
- Ten single-use recovery codes are issued once, at confirmation, and stored as SHA-256. They are high-entropy random strings, so a fast hash is right here in a way it never is for a password. They cannot be read back — if they could, a borrowed session would defeat the second factor entirely.
- Turning it off needs a current code or a recovery code, not merely a live session. Otherwise an unlocked laptop removes the protection that exists for exactly that case.
- Second-factor attempts are rate limited per account (ten per fifteen minutes) and per address (thirty), both configurable as `TWO_FACTOR_RATE_LIMIT_PER_ACCOUNT` and `TWO_FACTOR_RATE_LIMIT_PER_IP`; exhausting either destroys the pending session rather than leaving it open to retry. Six digits are guessable at scale if the attempts are not capped. The per-account ceiling is the meaningful one, and the per-address ceiling is higher for the same reason as sign-in: many legitimate people share an address.
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
- Synonyms, search visibility, search priority and index rebuilds are staff-only in `lib/`, audited, and rejected for customers at the API. Recording a search as another name for a product goes through `suggestAlias`, which requires `catalog.manage` and produces a *suggestion*; approving it requires `search.manage`. Both checks are inside `lib/pkb`, so `/api/admin/search/aliases` cannot be used to bypass either, and the button on the search screen is hidden only as a courtesy (D-094).
- The knowledge-backed search index (migration 0036) writes no free text into SQL: the structured terms a query is matched against are bound parameters in a `text[]`, and every term is built by `search_term_key`, which reduces its input to letters, digits and underscores. A query can therefore not reach the index as anything but data.
- Search analytics gained four first-party event kinds in Stage 5 (D-093) under the same rules as D-029. A **filter event records only which kinds of filter were used, never the values chosen** — what someone narrows to is far more identifying than that they narrowed. A **purchase event carries no visitor at all** (a database check enforces it) and is written only when a payment is confirmed. The search phrase that made the attribution possible lives on the cart line and then the order line, and is **cleared the moment it is counted**, so no order retains a record of what its customer searched for. The cookie that carries a search from a clicked result to the cart is httpOnly, SameSite=Lax, secure in production, names one search and one product, and expires in thirty minutes.
- Price, total, discount, capacity, and role are never read from client input for any computation — they are always re-derived server-side from the database, per [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md).
- File uploads (product images) are validated by content-type sniffing (not filename extension alone) and size limit, filenames are regenerated (never trusting the client's filename), and no executable or script-bearing file type is accepted. Every uploaded image is decoded and re-encoded on the server before it is stored (`lib/images/normalize.ts`, D-055): decoding is refused above 40 megapixels, EXIF orientation is applied, colour is converted to sRGB, all metadata (including GPS positions) is dropped, and the stored file is a single WebP of at most 2,400px. Bytes appended to an image do not survive. Responsive sizes are produced by `next/image` from that file. Files are deleted only by a sweep once nothing references them, so past orders keep their thumbnails.

## Payments

- **No real payment provider is connected yet** (PRODUCTION-READINESS 24.1, blocked on credentials); payments run through the mock provider. The provider interface is built so that a hosted flow (SSLCommerz, bKash, Nagad) collects card and wallet details itself: the application holds only a `provider_ref`, amounts and a status.
- Payment webhooks (`/api/webhooks/payments/[provider]`) verify an HMAC-SHA256 signature over the timestamp and body, reject stale timestamps, and are idempotent on the provider's event id — implemented and tested for the mock provider; each real provider must supply its own verification — a replayed or duplicated webhook call must not double-confirm a payment or double-release capacity.
- Refunds are issued through the same provider abstraction and always produce a `payments` row of `kind = 'refund'`, never a silent balance adjustment on the order alone.

## Data protection

- Secrets (database URL, `SESSION_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `CRON_SECRET`, Google and future provider keys) live in environment variables, never committed, documented by name (not value) in `.env.example`.
- `cost_price_usd`, computed margins, and internal admin notes are excluded at the query layer from any function that serves a customer-facing response — see [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md) pricing section.
- Business-critical records (`products`, `product_variants`, `orders`, `users`) are soft-deleted (`archived_at`), never hard-deleted, so an order placed against an archived product still resolves correctly in order history.
- A user's personal data can be anonymized on request (name, email, phone, address text replaced) while the `orders` and `payments` rows that reference them are retained, satisfying deletion requests without breaking financial record-keeping obligations.

### Error tracking

When `SENTRY_DSN` is set, server errors are sent to Sentry. What leaves the
server is limited in code, not in Sentry's settings: no user, cookies, request
bodies, query strings or headers other than user agent, content type and
request id; sensitive field names redacted; emails and phone numbers masked in
messages (`lib/observability/error-reporting.ts`, `tests/error-reporting.test.ts`).

## Audit

- Every admin mutation writes an `audit_log` row (actor, action, entity, before/after) in the same transaction as the change, per [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md). `audit_log` itself is insert-only from application code — no update or delete path exists for it.

## Transport and headers

- HTTPS is enforced at the hosting layer. Cookies are `Secure` in production (not in local development, which runs over plain HTTP), and production sends `Strict-Transport-Security`.
- `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` and, in production, `Strict-Transport-Security` are set for every response in `next.config.ts`.
- **Content-Security-Policy on pages** comes from `proxy.ts`, with a fresh nonce per response: `script-src 'self' 'nonce-…' 'strict-dynamic'`, no `'unsafe-inline'` or `'unsafe-eval'` for scripts in production, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. Styles allow `'unsafe-inline'` because the design uses style attributes, which a nonce cannot cover; styles cannot execute code. For the nonce to reach every script, every page is rendered for its request (`connection()` in the root layout, D-057). API responses, built assets and uploads get a static policy that allows no scripts. `e2e/csp.spec.ts` fails on any violation across the storefront, checkout and admin.
- **Cross-site request protection**: `proxy.ts` refuses (403) any API request other than GET/HEAD/OPTIONS whose `Origin` is another host, or that the browser marks `Sec-Fetch-Site: cross-site`. This is in addition to the `SameSite=Lax` session cookie. Payment webhooks and `/api/cron/*` are exempt: they are called by servers, carry no cookie, and authenticate with a signature or shared secret.

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

## Product Knowledge Base (D-060 to D-070)

- New permission `knowledge.manage` (owner, operations manager, product
  manager): approving families and their schema versions, attribute
  definitions, vocabulary aliases. Product-level knowledge work — setting,
  clearing and locking values, recording sources and evidence, proposing
  claims, relationships, suggesting a family or alias — needs
  `catalog.manage`. Product and variant aliases, which change search, are
  approved with `search.manage`. Every check is inside `lib/pkb`.
- The database refuses what code must never do: a VERIFIED value without an
  accepted, evidenced claim and a decision basis; an AI source type; AI-assisted
  evidence without a quoted excerpt; edits to fact history; edits to an active
  family schema.
- Knowledge tables hold no customer data. Actor columns reference staff only.
  Origin and usage rights are stored on every source so provider-restricted and
  unknown-rights data can be excluded from any future export
  (`lib/pkb/export.ts`).
- Nothing in Stage 2 fetches anything from the internet. Source retrieval, with
  its SSRF protection, is Stage 3.
- A locked value cannot be overwritten by a staff save through the old editor
  (the save is refused) nor by an unattributed write (it is reverted and
  recorded).

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
- A category's introductory copy (`categories.intro_html`, D-084) is
  staff-authored HTML rendered on a public shelf. It goes through the same
  `sanitizeRichText` allow-list as a product description before it is stored, so
  a staff role with catalogue access cannot store a script that runs for every
  shopper. A canonical address on a category is checked by the same rule as a
  listing's: a path on this site, or nothing (D-079).
- The SEO auditing modules (`lib/seo/{technical,images,duplicates,audit}.ts`)
  only read. `listingAudit` checks `catalog.manage` itself rather than relying
  on the screen that calls it, and nothing in them reaches the network.

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

## Admin API boundary (PRODUCTION-READINESS 18.1)

- Every handler under `app/api/admin` calls `refuseNonStaff()` (lib/auth/api-guard.ts) before reading the request: a signed-out caller gets 401 and a customer 403, whatever they sent. Each `lib/` function still enforces its own permission for staff roles. `e2e/admin-boundary.spec.ts` discovers every admin handler and page from the filesystem and checks both refusals, so a new route is covered automatically.
- `proxy.ts` redirects requests to `/admin` and `/account` that carry no session cookie with a 307 to sign in. It is an optimistic check (cookie presence only, no database); the pages' own session and role checks are authoritative.

## Retrieving external sources (knowledge platform, D-071, D-074)

The knowledge base reads pages it is pointed at. Every retrieval goes through
`lib/pkb/net/safe-fetch.ts`, and the protections were written with the first
line of retrieval code, not after it.

- **Address policy.** `isPublicAddress` refuses loopback, link-local, private
  and carrier-grade-NAT ranges, the cloud metadata address (169.254.169.254),
  IPv6 unique-local and mapped equivalents. The hostname is resolved once and
  the connection is pinned to the address that was checked, so a name that
  answers differently on the second lookup cannot reach an internal host
  (DNS rebinding).
- **Protocol and port.** http and https only, ports 80 and 443 only, no
  credentials in the URL, and a redirect from https to http is refused.
- **Redirects** are followed by hand, at most three hops, each hop re-checked
  against the same address policy.
- **Limits.** A request timeout (15 s by default), a decompressed response
  ceiling (2 MB), and a content-type allowlist checked before the body is read.
- **Parsing is inert.** HTML is parsed with htmlparser2; no script runs, no
  resource is fetched, no DOM is constructed. JSON-LD is size-capped before it
  is parsed.
- **robots.txt is obeyed** (RFC 9309, `lib/pkb/net/robots.ts`). An unreachable
  robots.txt means nothing on that host is read. A 401, 403 or 429 is recorded
  as a refusal with its status; nothing attempts to work around it.
- **Nothing is bypassed.** There is no code path that ignores a block: a
  blocked registry domain, a robots refusal and an access control all end as a
  `refused` document row with its reason, visible on the product's intelligence
  screen.
- **Rights stay conservative.** A retrieved source is stored with
  `usage_rights = internal_only` until someone decides otherwise, and provider
  data is treated as restricted.

## Search Console credentials and data (knowledge platform, D-096, D-100)

Google Search Console is optional. Connecting it puts a service-account key on
the server, so the boundary is drawn tightly.

- **Credentials are read in one file.** `lib/providers/search-console/google.ts`
  reads `GOOGLE_SEARCH_CONSOLE_CREDENTIALS` (or the client email and private key
  separately). Nothing else in the codebase reads them, no method returns them,
  and no page receives them. The connection state a screen renders carries the
  property and the service-account email, and a test asserts it carries no key
  material.
- **Nothing reaches the browser.** Every Search Console read is a server
  component or a `lib/` function behind `refuseNonStaff()` plus a
  `catalog.manage` check inside the service — never a client fetch to Google.
- **Failures name no secret.** A refused token exchange is reported by HTTP
  status only, because the response body can echo the signed assertion back. An
  unreadable key is reported as an unreadable key, not as the library's message.
- **Outbound requests go to fixed Google hosts** (`oauth2.googleapis.com`,
  `searchconsole.googleapis.com`) with a 30-second timeout. They are not
  user-supplied addresses, so they do not go through the SSRF fetcher, which
  exists for pages staff and the registry point the shop at.
- **What is stored is internal analytics.** Pages, queries and counts about this
  shop's own pages. It is `PROVIDER_RESTRICTED`: never exportable, never
  evidence for a product fact, and it holds no customer identifier. A Search
  Console query cannot become an alias, an attribute or SEO copy without a
  person suggesting it and a second decision approving it (D-100).
- **Reading it needs `catalog.manage`**, checked inside `lib/`, not in the
  screen.

## The final audit's security and authorization findings (Stage 8)

Three of the five defects the final audit found were on this boundary. Each is
fixed, and each has a test that fails without the fix.

- **A re-check that was a write.** The knowledge screen's "check the identity
  again" button reached `refreshResolution` through the admin API on the grounds
  that re-checking is a read. It is a write: it stores the resolution state,
  appends a history row, and where the state is no longer VERIFIED it clears
  `resolution_decided_by` and `resolution_decided_at` — so any staff account,
  including one with no catalogue permission at all, could discard a confirmed
  product identity, unattributed. `reassessResolution` now asks for
  `catalog.manage` inside `lib/`, which is what every other resolution write asks
  for, and takes the row's lock before it reads it. The general rule this
  restates: **a function that writes asks for permission wherever it is called
  from, and "it only re-reads" is not an exemption** (invariant I-14).
- **A decision that could be overwritten.** `decideAlias` checked "this alias is
  still only suggested" against a read taken outside its transaction, so two
  decisions arriving together both passed and the second overwrote the first — an
  approved alias, which is live search vocabulary, could become rejected,
  recorded against whoever committed last. The row is now read under `for update`
  inside the transaction, and the update carries the status in its `where` as
  well. This was the third instance of one shape (D-110); the rule is now an
  invariant, I-22: **where a write depends on a row's current state, the lock
  comes before the check, and the check is repeated in the write's own
  predicate.**
- **Unbounded deletes in a scheduled job.** Every prune deleted everything past
  its retention window in one statement and materialised an identifier per row.
  Not an attack, but a scheduled job whose memory and transaction size are
  decided by how much has accumulated is a denial of service the shop inflicts on
  itself. All of them are batched now (D-111).

**Verified, not assumed, in the same audit.** All 49 admin API routes refuse a
non-staff caller before they read a body, and every `lib/` function they call
checks a permission. All 24 admin pages call `requireAdminPage(<permission>)`;
the overview is the only exception and it is `requireStaff` plus a `can` check
per tile. No credential variable, connection string, private key or
service-account address appears anywhere under `.next/static` — no `process.env`
reference survives in the client bundles at all. `safeFetch` was re-reviewed
end to end: protocol, credentials in the address, port, host name, one DNS
lookup whose every answer must be public, a connection pinned to the vetted
address, redirects followed by hand and re-checked at each hop with no downgrade
from https, a hard timeout, a size cap given to zlib as well as counted, and an
allow-list of document types. It remains the only path by which the knowledge
base reaches the internet; the media provider's one direct `fetch` reads a blob
address built from a validated key of this shop's own store, which is why it is
not that path.

**Left alone, and recorded rather than hidden:** `deliverQueuedNotifications` is
gated with `requireStaff` rather than with `notifications.view`, so any staff
role can drain the outbox to real customers. It is Phase-era code, outside the
knowledge programme's surface, and `notifications.view` is the permission it
should ask for.

## Product preparation (D-112 to D-114)

Preparation reaches several systems at once, so the boundary is worth stating
explicitly: **it adds no authority.** Every step calls the function that already
did that work, and every one of those functions checks its own permission.

- Starting, reading, retrying, cancelling and continuing a preparation run all
  ask for `catalog.manage` — the permission a product save already asks for.
  The two API routes refuse a non-staff caller before they read the body.
- Trust decisions are unchanged and are not reachable from here. Approving a
  source domain, a brand relation or a verification policy still asks for
  `knowledge.manage` in `lib/pkb`. A run that finds an official-looking domain
  it cannot trust reports it as something a person must decide; it cannot
  approve it.
- Identity is never auto-confirmed. VERIFIED is only ever set by a person
  (D-072), and an ambiguous identity stops the run.
- The worker has no privileged mode. It acts as the staff member who started the
  run, loaded from `users`, and every function it calls checks that account's
  permission again. An account that has been removed, or has lost the
  permission, stops the run rather than letting it continue unattributed.
- Nothing a run reports carries a stack trace or a raw error. A failure is a
  code, a sentence and a remedy, which is asserted by a test.

### The research provider's credential

`BRAVE_SEARCH_API_KEY` is read only by `lib/providers/research/brave.ts`, on the
server, and is sent only to one pinned host (`api.search.brave.com`) that is
never taken from configuration or from a response. It appears in no client
bundle and in no stored row. Without the key the provider reports UNAVAILABLE and
the pipeline carries on.

The provider is not a way around the retrieval rules. It returns addresses; every
one of them is still fetched through `safeFetch` with its SSRF, redirect, size
and content-type controls, still checked against robots.txt, and still refused if
the Brand Source Registry blocks its domain (D-114).

### Intelligent document extraction (D-123)

- **The model reads; it does not fetch.** `lib/providers/extraction` is given
  the stored text of a document Manifest already retrieved through `safeFetch`
  (or a person provided). It has no tools, no browsing and no address to follow.
- **Its answer is untrusted input.** Strict JSON, reduced to well-formed
  candidates (`readCandidates`), then checked deterministically against the
  document's own text (`lib/pkb/grounding.ts`). A value whose excerpt is not in
  the document, whose numbers or words the excerpt does not state, or which is
  identity, marketing or an offer term, is dropped. The stored evidence is the
  document's excerpt, never the model's wording.
- **It decides nothing.** A surviving candidate is a claim or a proposal like any
  other, decided by a person with the usual permission. It can count as VERIFIED
  only under a policy an owner explicitly activates.
- **Prompt injection in a page** can at worst make the model point at text that
  is really on the page: grounding admits nothing else, and nothing becomes a
  fact without a person.
- **The credential.** `ANTHROPIC_API_KEY` is read on the server only
  (`lib/env.ts`, `lib/seo-pulse/config.ts`), sent only to Anthropic by the
  official SDK, and never shown: the admin screens report only "Configured" or
  "Not configured".

## Local research and AI (D-124)

- **Local services are loopback only.** `OLLAMA_BASE_URL` and
  `SEARXNG_BASE_URL` must name `127.0.0.1`, `localhost` or `::1` unless
  `OLLAMA_ALLOW_REMOTE` or `SEARXNG_ALLOW_REMOTE` is set explicitly. Addresses
  with credentials are refused. Redirects from these services are not followed,
  and their answers are size- and time-capped.
- **No cloud fallback.** With `ollama` selected, a stopped or failing Ollama
  means no AI: extraction reports UNAVAILABLE, and SeoPulse uses the local rules
  generator. Anthropic is never called in its place, even when a key is set.
  DataForSEO is not called while SeoPulse runs locally.
- **Nothing is logged whole.** Provider errors and events carry states and
  counts, never document text or model answers.
- **The browser renderer cannot bypass SSRF protection.** It starts only from an
  address `vetDestination` accepts. Chromium runs with no name resolution and a
  dead proxy for all traffic, so it has no network of its own. Every request is
  intercepted: the document comes from the copy already fetched, and scripts,
  styles, XHR and fetch go through robots.txt and `safeFetch`. Everything else
  is refused, including navigation away, frames, WebSockets, beacons and
  non-GET requests. There are no cookies, credentials, logins or stored state.
  A CAPTCHA or bot check is reported, never solved. Contexts and the browser are
  closed after every page. `tests/local-browser-render.test.ts` runs a real
  Chromium against a page that tries to reach an internal server by eight routes;
  the server sees no connection.
- **Sitemaps and search results are addresses.** Sitemaps are read only from
  approved official domains, after robots.txt allows them, within fixed limits.
  A search snippet is kept only as the provider's note and never becomes
  evidence.

## Hosted research services and real email (D-132, D-133)

- **Remote AI and search are opt-in, and private or encrypted.** A
  non-loopback `OLLAMA_BASE_URL` or `SEARXNG_BASE_URL` is refused unless its
  `*_ALLOW_REMOTE` flag is true, so an address changed by mistake sends no
  product document anywhere. An allowed remote address must be on a private
  network (a private IP, a single-label service name, a name under `.internal`
  or `.local`) or use https. Judged from the name, with no lookup.
- **Ollama has no authentication.** It is never to have a port open to the
  internet: a private network, or a reverse proxy that requires
  `OLLAMA_AUTH_TOKEN`. The token is sent as a bearer header, is never logged
  or put in an error, and — by the rule above — never crosses the internet in
  the clear. The same holds for `SEARXNG_AUTH_TOKEN`. The application cannot
  check a firewall; the operator must.
- **The worker listens on nothing.** It has no HTTP server and no port.
- **`/api/cron/revalidate`** needs CRON_SECRET, accepts only this
  application's own cache tags, and can only mark cache entries stale.
- **The health report carries no secret.** `/api/admin/health` needs staff and
  `notifications.view`; `/api/cron/health` needs CRON_SECRET and tells an
  unauthenticated caller nothing. Neither returns an address, a key, a prompt
  or a recipient (`tests/worker.test.ts`).
- **Email.** Plain text; one validated recipient; subject on one line; TLS
  required; no file or URL read into a message. A failure is recorded by kind,
  built from the reply code — never the provider's own text — so no password,
  user or host reaches the outbox or a log. `notification.*` log events omit
  the recipient. Staging restricts recipients with
  `NOTIFICATION_RECIPIENT_ALLOWLIST`.
- **The local-AI slot** refuses a pooled database address, where its lock
  would not be a lock.

## Staging readiness (D-134)

- **The wrong database is refused before a write.** With
  `EXPECTED_DATABASE_NAME` set, migrations and the worker compare
  `current_database()` first. The staging check refuses development, test,
  scale and provider-default databases as staging.
- **A pooler is not trusted to be direct.** Only Neon's host says what it
  is; anything else is `unknown` until `DATABASE_CONNECTION_MODE` declares
  it, and the worker tests a real session lock before local AI may run.
- **Preview and Production share no database, secret or media store**
  (docs/STAGING.md, "Read this first"; D-135): Preview has its own session
  and cron secrets, Blob store and database (`manifest_staging`, a separate
  Neon project), and production's Neon resource reaches Production only.
  `EXPECTED_DATABASE_NAME` stops a Preview build before it migrates any
  other database. Preview deployments stay behind Deployment Protection.
- **Media stays in its own folder.** A Blob provider claims, reads, sweeps
  and deletes only under `MEDIA_BLOB_PREFIX`; `delete` refuses anything
  outside it.
- **Ollama across a network**: bound to a private address only, or behind the
  Caddy gateway that answers `/api/tags` and `/api/chat` only, only with the
  bearer token, and refuses all requests when no 32+ character token is set.
  Pulling or deleting models is never exposed.
- **Health and the staging check carry no value.** Refusal reasons no longer
  name the refused host; the staging check prints names, states and database
  names only; library error text (which can quote an address) is replaced by
  the kind of failure.
- **The web tier needs no private service.** Under `JOB_RUNNER=worker` a
  provided document is not sent towards a private model from a web request.
- **Container**: the worker image runs as `node` under tini, contains no
  `.env` file or secret (`.dockerignore`), and its health check touches no
  database or network.
