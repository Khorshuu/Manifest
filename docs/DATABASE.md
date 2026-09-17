# Database

> **Product Knowledge Base.** Product identity, facts, identifiers,
> relationships, aliases and their sources now also live in `pkb_*` tables
> (migration 0031, described at the end of this page). The legacy product
> columns below remain what the storefront reads; the knowledge base mirrors
> them until readers move (KNOWLEDGE_PLATFORM.md, D-060 to D-070).

PostgreSQL. All monetary columns are integers in minor units, with an explicit currency: `_bdt` suffix for paisa a customer pays, `_usd` suffix for cents the operator spends sourcing a product in the US. Every table has `created_at timestamptz`; mutable tables also have `updated_at timestamptz`. Business-critical tables (`products`, `product_variants`, `orders`) are soft-deleted with `archived_at timestamptz null`, never hard-deleted, because order history references them.

## Users, roles, addresses

```
users
  id                  uuid pk
  email               text unique not null
  phone               text unique
  password_hash       text not null
  role                text not null check (role in ('super_admin','staff_admin','customer'))
  email_verified_at   timestamptz
  created_at          timestamptz not null default now()

sessions
  id                  uuid pk
  user_id             uuid not null references users(id)
  expires_at          timestamptz not null
  created_at          timestamptz not null default now()

addresses
  id                  uuid pk
  user_id             uuid not null references users(id)
  label               text
  recipient_name      text not null
  phone               text not null
  address_line1       text not null
  address_line2       text
  city                text not null
  district            text not null
  postal_code         text
  is_default          boolean not null default false
  created_at          timestamptz not null default now()
```

Role is a single column, not a separate roles/permissions table — there are exactly three fixed roles (MASTER_PRODUCT_SPEC.md §1), and a general permissions table would model flexibility nothing requires yet. `staff_admin`-only exclusions (can't manage other admins, financial/site settings) are enforced in code at the point of use, listed in [SECURITY.md](SECURITY.md), not modeled as rows.

## Catalog

```
categories
  id                  uuid pk
  parent_id           uuid references categories(id)
  name                text not null
  slug                text unique not null
  sort_order          int not null default 0
  created_at          timestamptz not null default now()

products
  id                  uuid pk
  category_id         uuid not null references categories(id)
  title               text not null
  slug                text unique not null
  brand               text
  sku                 text                  -- unique when set (partial unique index)
  identifier_type     text check (identifier_type in
                       ('gtin','upc','ean','isbn','asin','mpn','other'))
  identifier_value    text
  description_html    text
  bullet_features      jsonb                 -- string[], the key features
  spec_table          jsonb                 -- [{ label, value }], typed by hand
  box_contents        jsonb                 -- string[], what is in the box
  warranty            jsonb                 -- { hasWarranty, durationMonths, type,
                                            --   provider, description, terms }
  compliance          jsonb                 -- { certifications: [{ name, number }],
                                            --   compliance, safety, warnings,
                                            --   countryOfOrigin, regulatory }
  details             jsonb                 -- the advanced attribute block; see
                                            --   ProductDetails in db/schema/catalog.ts
  attribute_values    jsonb                 -- { [categoryAttributeId]: value }
  video_url           text
  search_keywords     jsonb                 -- string[], never shown to a shopper
  seo_meta_title       text
  seo_meta_description text
  seo_no_index        boolean not null default false
  canonical_url       text
  status              text not null check (status in
                       ('draft','scheduled','in_stock','preorder_open',
                        'preorder_closed','coming_soon','discontinued','archived'))
  publish_at          timestamptz           -- for 'scheduled'
  unpublish_at        timestamptz           -- when the listing should come down
  archived_at         timestamptz
  created_at          timestamptz not null default now()
  updated_at          timestamptz not null default now()

product_categories                          -- secondary categories, product_id+category_id pk
  product_id          uuid not null references products(id)
  category_id         uuid not null references categories(id)

product_images
  id                  uuid pk
  product_id          uuid not null references products(id)
  url                 text not null
  alt_text            text not null
  sort_order          int not null default 0   -- ordered within its kind
  kind                text not null default 'gallery'
                       check (kind in ('gallery','lifestyle'))

category_attributes                          -- specifications a category asks its products for
  id                  uuid pk
  category_id         uuid not null references categories(id)
  name                text not null
  data_type           text not null check (data_type in
                       ('text','number','boolean','select','multiselect',
                        'date','measurement','color','url'))
  unit                text                     -- "Hz", "mm"; appended when shown
  options             jsonb                    -- string[], for select and multiselect
  is_required         boolean not null default false
  sort_order          int not null default 0
  unique (category_id, name)

product_related
  product_id          uuid not null references products(id)
  related_product_id  uuid not null references products(id)
  kind                text not null check (kind in ('related','frequently_bought_together'))
```

Two attribute systems live in this schema and they are deliberately separate. `attributes` (below) is the **variation** system: adding a value there multiplies the SKUs a product has. `category_attributes` is the **specification** system: it describes one product and generates nothing. Conflating them would mean choosing a processor generated a variant per processor.

A product answers its category attributes in `products.attribute_values`, keyed by definition id. Keeping the values on the product rather than in a join table means the whole listing is read in one row, and deleting a definition takes its answers with it (`lib/catalog/category-attributes.ts`).

`categories.parent_id` self-references with no fixed depth limit, satisfying "at least 3 levels" without hardcoding exactly 3 — a category tree is walked recursively wherever it's rendered (breadcrumb, nav, admin picker).

## Attributes and variants (EAV)

```
attributes
  id                  uuid pk
  name                text not null           -- "Color", "Storage", "Edition"
  input_type          text not null check (input_type in ('select','text','number'))
  created_at          timestamptz not null default now()

attribute_values
  id                  uuid pk
  attribute_id        uuid not null references attributes(id)
  value               text not null            -- "Red", "128GB"
  sort_order          int not null default 0
  unique (attribute_id, value)

product_attributes                            -- which attributes this product varies by
  product_id          uuid not null references products(id)
  attribute_id        uuid not null references attributes(id)
  sort_order          int not null default 0
  primary key (product_id, attribute_id)

product_variants
  id                  uuid pk
  product_id          uuid not null references products(id)
  sku                 text unique not null
  price_bdt           int not null              -- what the customer pays, or delta — see note
  price_is_delta      boolean not null default false
  cost_price_usd      int                       -- sourcing cost; admin/staff read only, see SECURITY.md
  weight_grams        int
  dimensions_mm        jsonb                     -- { length, width, height }
  is_enabled          boolean not null default true   -- false = generated combo, deliberately disabled
  fulfillment_mode    text not null check (fulfillment_mode in ('in_stock','preorder'))
  stock_quantity      int                       -- in_stock only
  preorder_capacity   int                       -- preorder only
  preorder_reserved   int not null default 0    -- preorder only, updated only inside a capacity-check transaction
  sale_price_bdt      int                       -- <= price_bdt; null means no sale
  sale_starts_at      timestamptz               -- null means "already started"
  sale_ends_at        timestamptz               -- null means "until removed"
  low_stock_threshold int                       -- in_stock only; at or below, "Low stock"
  preorder_closes_at  timestamptz               -- preorder only
  payment_mode        text not null default 'full' check (payment_mode in ('full','deposit'))
  deposit_percent     int                       -- 1-99, required when payment_mode = 'deposit'
  archived_at         timestamptz
  created_at          timestamptz not null default now()
  updated_at          timestamptz not null default now()

variant_option_values                          -- one row per (variant, attribute) pair
  variant_id          uuid not null references product_variants(id)
  attribute_id        uuid not null references attributes(id)
  attribute_value_id  uuid not null references attribute_values(id)
  primary key (variant_id, attribute_id)

waitlist_entries
  id                  uuid pk
  variant_id          uuid not null references product_variants(id)
  user_id             uuid references users(id)
  email               text not null
  created_at          timestamptz not null default now()
  notified_at         timestamptz
```

A product with no variation still gets exactly one row in `product_variants`, so price, stock, and preorder state always live in one place — never conditionally on the product when unvaried and the variant when varied.

`price_is_delta` lets a variant store either a full price or a delta added to a product-level base price; the spec allows either, and the delta case is what makes bulk-editing dozens of combinations by a single base-price change tractable. `cost_price_usd` and `preorder_reserved`/`preorder_capacity` remaining-slot math are read only by admin/staff-facing queries — never returned by any customer-facing endpoint (MASTER_PRODUCT_SPEC.md §7: never expose supplier costs or margins).

## Cart

```
carts
  id                  uuid pk
  user_id             uuid references users(id)     -- null for guest
  session_token       text unique                    -- set for guest carts
  created_at          timestamptz not null default now()

cart_items
  id                  uuid pk
  cart_id             uuid not null references carts(id)
  variant_id          uuid not null references product_variants(id)
  quantity            int not null check (quantity > 0)
  added_at            timestamptz not null default now()
```

Cart items store no price. The cart page always re-reads live price and availability from `product_variants` on render, so a stale cached price can never be shown or charged.

## Orders

```
orders
  id                  uuid pk
  order_number        text unique not null        -- human-facing, e.g. "ORD-2026-000123"
  user_id             uuid references users(id)    -- null for guest checkout
  guest_email         text
  guest_phone         text
  status              text not null check (status in
                       ('placed','payment_confirmed','sourcing','shipped_from_us',
                        'in_bd_customs','out_for_delivery','delivered',
                        'cancelled','refunded'))
  shipping_address_id uuid not null references addresses(id)
  subtotal_bdt        int not null
  shipping_fee_bdt    int not null default 0
  discount_bdt        int not null default 0
  total_bdt           int not null
  amount_due_now_bdt  int not null                -- deposit or full amount charged at placement
  idempotency_key     text unique not null
  placed_at           timestamptz not null default now()
  archived_at         timestamptz

order_items
  id                  uuid pk
  order_id            uuid not null references orders(id)
  variant_id          uuid not null references product_variants(id)
  title_snapshot      text not null
  option_summary_snapshot text            -- e.g. "Color: Red, Storage: 128GB"
  unit_price_bdt      int not null
  quantity            int not null
  fulfillment_mode_snapshot text not null

order_status_history
  id                  uuid pk
  order_id            uuid not null references orders(id)
  status              text not null
  note                text
  actor_user_id       uuid references users(id)     -- null = system/webhook-driven transition
  created_at          timestamptz not null default now()

payments
  id                  uuid pk
  order_id            uuid not null references orders(id)
  kind                text not null check (kind in ('deposit','balance','full','refund'))
  provider            text not null                 -- 'sslcommerz', 'mock', ...
  provider_ref        text
  amount_bdt          int not null
  status              text not null check (status in
                       ('initiated','authorized','captured','failed','refunded'))
  raw_payload         jsonb
  created_at          timestamptz not null default now()
```

An order snapshots title, option summary, and price on each `order_item` at the moment of purchase — it never re-joins to the live `product_variants` row, so a later price or attribute edit cannot rewrite history. Idempotency is enforced by a unique constraint on `orders.idempotency_key`, checked inside the same transaction that would otherwise create a duplicate.

## Reviews and audit

```
reviews
  id                  uuid pk
  product_id          uuid not null references products(id)
  user_id             uuid not null references users(id)
  order_item_id       uuid not null references order_items(id)   -- proves verified purchase
  rating              int not null check (rating between 1 and 5)
  title               text
  body                text
  status              text not null default 'pending' check (status in ('pending','approved','rejected'))
  created_at          timestamptz not null default now()
  unique (user_id, product_id)

audit_log
  id                  uuid pk
  actor_user_id       uuid not null references users(id)
  action              text not null              -- "product.price_changed", "variant.capacity_changed", ...
  entity_type         text not null
  entity_id           uuid not null
  before_json         jsonb
  after_json          jsonb
  created_at          timestamptz not null default now()

site_settings
  key                 text pk
  value_json          jsonb not null
  updated_by          uuid references users(id)
  updated_at          timestamptz not null default now()
```

`reviews.order_item_id` is what makes "verified/delivered purchase" checkable in a single join rather than a separate flag someone has to remember to set correctly. `audit_log` is append-only from application code — nothing ever updates or deletes a row in it — and is written to by every admin mutation named in MASTER_PRODUCT_SPEC.md §4 and §7 (price changes, capacity changes, and more broadly any create/edit/archive on `products`, `product_variants`, `orders`, `users`, `site_settings`).

## Two-factor authentication

```
users
  totp_secret          text                  -- base32; present while enrolling, live once confirmed
  totp_confirmed_at    timestamptz           -- null means it is not switched on
  totp_last_used_step  int                   -- the last 30-second step spent, so a code cannot be replayed

sessions
  pending_two_factor   boolean not null default false   -- passed the password, not yet the code

recovery_codes
  id                  uuid pk
  user_id             uuid not null references users(id)
  code_hash           text not null          -- SHA-256; the code itself is shown once and never stored
  used_at             timestamptz            -- set the first time it works
  created_at          timestamptz not null default now()
```

Added in migration `0007`. A pending session is a real row that `validateSessionToken` refuses, so a half-finished sign-in authenticates nothing anywhere (see SECURITY.md).

## Notification delivery attempts

`notifications.attempts` (migration `0008`) counts delivery attempts. The scheduled sweep picks up queued messages and failed ones below five attempts, so a provider outage heals by itself; past that a message is left alone rather than retried forever (see BUSINESS_LOGIC.md).

## Rate limiting

```
rate_limit_hits
  key                 text not null              -- SHA-256 of the limiter key, never the email or IP
  window_start        timestamptz not null       -- aligned to an absolute grid, so processes agree
  count               int not null default 0
  updated_at          timestamptz not null default now()
  primary key (key, window_start)
```

Added in migration `0006`. One row per key and window, incremented by a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, which is what makes two simultaneous attempts unable to both take the last slot. Closed windows are swept opportunistically from the login path (see SECURITY.md).

## Landed price on an order

`orders` carries the split of every landed price, added in migration `0004`:

```
orders
  subtotal_bdt        int not null   -- goods value
  shipping_fee_bdt    int not null   -- freight into Bangladesh
  duty_bdt            int not null   -- customs duty
  total_bdt           int not null   -- what the shopper pays; equals the three above
```

The three parts always sum to `total_bdt` exactly. Nothing is charged on top: the price is the input to the split, not the output (DECISIONS.md D-010). Orders written before migration `0004` have zero shipping and zero duty, which still satisfies the sum.

The rates live in `site_settings` under `landed.shipping_per_kg_bdt`, `landed.duty_percent` and `landed.assumed_weight_grams`.

Migration `0005` widened `audit_log.entity_id` from `uuid` to `text`, because a site setting is keyed by name rather than by id and the audit log has to be able to name what changed.

## Notifications

```
notifications
  id                  uuid pk
  order_id            uuid references orders(id)
  user_id             uuid references users(id)
  recipient           text not null              -- address or number as it was at send time
  channel             text not null check (channel in ('email','sms'))
  template            text not null              -- "order.payment_confirmed", ...
  subject             text not null
  body                text not null
  status              text not null default 'queued' check (status in ('queued','sent','failed'))
  dedupe_key          text not null unique       -- "order:<order id>:<status>"
  provider_message_id text
  error               text                       -- for staff; never shown to the customer
  created_at          timestamptz not null default now()
  sent_at             timestamptz
```

This is a transactional outbox (DECISIONS.md D-009). A row is written in the same transaction as the order change that caused it, so a message exists if and only if the change committed, and delivery is a separate step that can fail and be retried. `recipient`, `subject` and `body` are stored rather than re-derived at send time: what was said to a customer should not change because a template or an email address later did.

`dedupe_key` is the idempotency guarantee. A replayed payment webhook produces the same key, the unique constraint refuses the second insert, and the customer is not told twice.

## Indexes worth calling out now

- `product_variants (product_id)`, `(fulfillment_mode, preorder_closes_at)` for the storefront's "open preorders closing soon" queries.
- `orders (user_id, placed_at desc)` and `(status)` for account order history and the admin order pipeline view.
- `categories (parent_id)` for tree traversal.
- Search: see "Search and discovery" below.
- `order_items (variant_id)` for best-selling, `products (brand)`, and a
  `jsonb_path_ops` GIN on `products.attribute_values` for specification filters.

## Search and discovery (migration 0014)

```
products
  searchable          boolean not null default true   -- off: hidden from search only
  search_boost        smallint not null default 0     -- -2..2, reorders within a tier

category_attributes
  is_filterable       boolean not null default true   -- text/url/date start false
  is_searchable       boolean not null default true

product_search                                        -- one row per product
  product_id          uuid pk references products on delete cascade
  document            tsvector   -- A name, B brand/model/codes/keywords/shelf,
                                 -- C highlights/options/specs, D the rest
  title_norm, title_core, title_words, brand_norm, category_norm
  codes               text[]     -- skus, identifiers, model/part numbers, unpunctuated
  text_a..text_d      text       -- what the document was built from
  indexed_at          timestamptz

product_search_words (product_id, word) pk, display, weight   -- trigram GIN on word
product_search_queue (product_id pk, queued_at, attempts)
search_synonyms      (id, term unique, synonyms text[], bidirectional, created_by)
search_queries       (query, query_norm, results_count, corrected_query,
                      visitor_hash, window_start)  unique (visitor_hash, query_norm, window_start)
search_clicks        (query_norm, product_id, position, visitor_hash, window_start)
search_history       (user_id, query_norm) pk, query, searched_at
```

Nothing in the application writes `product_search`, `product_search_words` or
the queue. Triggers on `products`, `product_variants` (sku, enabled, archived
only — never capacity), `variant_option_values`, `attribute_values`,
`categories` and `category_attributes` queue the affected products, and a
deferred constraint trigger calls `refresh_product_search(ids)` once per
product at commit. `search_normalize`, `search_code` and `search_slug` are the
normalisation functions both the index and the queries use.

## Open schema questions

- Exact deposit/balance flow: does a `payment_mode = 'deposit'` order automatically get a second `payments` row created when the batch ships, or does staff trigger that manually from the admin order screen? Affects whether `orders` needs a `balance_due_bdt` column now or later.
- Whether `waitlist_entries` needs a `notified_at`-driven automatic re-offer when capacity frees up (a cancellation), or staff handle it manually for v1.

## `newsletter_subscribers` (migration 0015)

One row per email address (`email` unique, stored lowercase), an optional
`user_id` when the signup came from a signed-in account, a `source`, and
`subscribed_at` / `unsubscribed_at`. Unsubscribing stamps the date instead of
deleting, so the consent record survives; signing up again clears it.

Related rules added in the same pass, with no schema change:

- `wishlist_items` now has a UI and API. It still stores no price.
- `addresses` rows referenced by `orders.shipping_address_id` are never
  updated or deleted. Editing one copies it and detaches the old row
  (`user_id` null); see DECISIONS.md D-032.

## Migrations 0016–0017 (UX and roles session)

- `users.role` check constraint widened to the seven staff roles plus
  `customer` (`super_admin`, `staff_admin`, `product_manager`,
  `order_manager`, `support`, `marketing`, `finance`). D-034.
- `users.first_name`, `users.last_name` — optional; the header greets by first
  name. Collected at sign-up.
- `users.admin_inbox_seen_at` — per staff member, where the admin inbox was
  last read (D-036).
- `site_settings` key `home.campaigns` — five homepage slides, each a hero and
  four tiles, validated by `campaignsSchema` in `lib/homepage/campaigns.ts`
  (D-035). `home.hero` and `home.showcase` remain but are only read to convert
  them the first time.

## Migration 0018 — `sku_reservations` (D-037)

`id, sku, status (reserved|finalized|released), reserved_by → users,
product_id → products (set when finalized), reserved_at, expires_at,
finalized_at, released_at`. Partial unique index on `sku` where status is
`reserved` or `finalized`: a SKU can be held or permanent only once. Index on
`expires_at` for open holds, used by the expiry sweep. Finalized rows are the
permanent SKU history and are never deleted.

## Migration 0019 — SEO Pulse (D-038)

`seo_research_runs`: `id, product_id → products, version (unique per
product), status (running|completed|failed), request_key (unique — one row
per click), initiated_by → users, input_snapshot jsonb, input_hash, research
jsonb, analysis jsonb, seo_score, search_score, provider_usage jsonb,
pulse_version, error, applied_fields jsonb, applied_at, applied_by → users,
created_at, completed_at`. Indexed on `(product_id, created_at)` and
`created_at`. Rows are never deleted or replaced; regenerating inserts the
next version. The JSON shapes are `SeoPulseInput`, `SeoResearchData`,
`SeoAnalysis` and `ProviderUsage` in `lib/seo-pulse/types.ts`.

`products.seo_focus_keyword` (text, nullable): the phrase a listing is
written to rank for. Never shown to shoppers.

## Migration 0021 — `oauth_accounts`, and an optional password (D-042)

`users.password_hash` becomes nullable: an account that only ever signs in with
Google has no password, rather than a random one nobody knows.
`lib/auth/accounts.ts` refuses a null hash exactly as it refuses a wrong
password.

`oauth_accounts`: `id, user_id → users, provider (check: google),
provider_account_id, email (as reported at link time, for support), created_at`.
Unique on `(provider, provider_account_id)` — one account per external
identity — and indexed on `user_id`. The subject identifier is what is matched
on; the email column is never used to find an account.

## Migration 0022 — measurements, and the variant an order bought (D-043)

`products.measurements` (jsonb, nullable): `Array<{ label, value }>` of
measurable facts — length, weight, capacity. Its own column rather than rows
in `spec_table` so the product page can offer Measurements as a tab and hide
that tab when there are none, and so nothing generated can quietly add a
dimension.

`order_items.sku_snapshot`, `order_items.image_url_snapshot` and
`order_items.variant_options_snapshot` (jsonb,
`Array<{ label, value }>`): what was bought, frozen at placement beside the
title and price the row already kept. `option_summary_snapshot` existed but was
never written; it is now. All four are null on orders placed before this
migration, and every screen treats null as "not recorded" rather than showing
a placeholder.

## Indexes added for admin at scale (PRODUCTION-READINESS 14.1)

- `audit_log (created_at DESC, id DESC)` replaces `audit_log (created_at)`: the log is paged by keyset on that pair, because entries written in one transaction share a timestamp.
- `audit_log (action, created_at DESC, id DESC)`: the log filtered by action, and the distinct action list read by skipping along it.
- `variant_option_values (attribute_value_id)`: counting and checking variants per option value (279 → 3 ms for a 250-value product).

## Migration 0031 — Product Knowledge Base (D-060 to D-070)

The reusable record of what each product *is*, apart from the listing that sells
it (`products`) and the offer that prices it (`product_variants`). Every table is
prefixed `pkb_`, written only by `lib/pkb`, and holds no customer data. Status,
invariants and the migration plan: [KNOWLEDGE_PLATFORM.md](KNOWLEDGE_PLATFORM.md).

**Domains.** `pkb_origin` (MANIFEST_CREATED, MANUAL_ADMIN, OFFICIAL_MANUFACTURER,
APPROVED_EXTERNAL_SOURCE, SUPPLIER_PROVIDED, PROVIDER_RESTRICTED, CUSTOMER_DERIVED,
UNKNOWN_LEGACY), `pkb_verification_state` (VERIFIED, MANUAL, UNVERIFIED, LEGACY),
`pkb_review_status` (suggested, approved, retired), `pkb_value_status`
(normalized, unnormalized, not_applicable).

| Table | Holds | Rules enforced by the database |
| --- | --- | --- |
| `pkb_brands` | Brand and manufacturer entities | unique normalized name and slug; approved needs a decision time |
| `pkb_attribute_definitions` | Global attribute vocabulary: key, label, data type (text, number, quantity, quantity_range, boolean, enum, date, url, brand), cardinality, unit dimension, display unit, search/filter/SEO/structured-data flags | key unique, snake_case and permanent; unit dimension exactly for quantities; type, cardinality and dimension fixed once values exist |
| `pkb_attribute_options` | Controlled values of enum attributes | enum definitions only; unique key per definition |
| `pkb_families` | Product Families; `legacy_category_id` when mirrored from a category | no cycles, at most eight deep |
| `pkb_family_versions` | Versioned schemas | draft → active → retired only; one active per family; only drafts deletable |
| `pkb_family_attributes` | A definition's role in a version: required/recommended/optional, variant-defining, flag overrides | editable only while the version is a draft; variant-defining attributes are single-valued |
| `pkb_products` | Product identity: name, family assignment (assigned/suggested/unassigned, and its source), resolution state, merge | assigned only to an approved family and suggested only to a suggested one (checked at commit) |
| `pkb_variants` | Variant identity | unique (id, product) as the target of variant foreign keys |
| `pkb_facts` | Accepted values: raw text, unit and label; typed normalized columns; state; origin; source; claim; decision; lock; `legacy_ref` | one row per slot (product, variant, definition, ordinal); value shape matches the definition (trigger); not-applicable carries no value; VERIFIED needs a claim and a decision basis; MANUAL needs a decider; LEGACY exactly when origin is UNKNOWN_LEGACY; a variant value belongs to its own product's variant |
| `pkb_fact_history` | Before/after snapshots of every fact change, with actor and reason | append-only; removed only with the whole product record |
| `pkb_sources` | Where information came from and how it was acquired (`acquisition_method`), authority tier, usage rights | no AI source type exists; legacy imports and UNKNOWN_LEGACY go together; URL sources carry a normalized address; one row per (address, content hash) |
| `pkb_evidence` | A located passage in a source | AI-assisted extraction must quote an excerpt |
| `pkb_claims` | Proposed values tied to evidence: SUGGESTED, CONFLICT, ACCEPTED, REJECTED, SUPERSEDED | evidence required; accepted/rejected need a decision; same value shape rules as facts |
| `pkb_identifiers` | GTIN-8/12/13/14, ISBN-10/13, MPN, model number, ASIN, other; raw, normalized, GTIN-14 form, validation | a GTIN is held by one product; invalid values keep no normalized form; same state rules as facts |
| `pkb_relationships` | accessory_for, compatible_with, successor_of, replacement_for, bundle_contains, requires, related_to, same_series | no self-relationships; symmetric kinds stored once in id order; state rules as facts |
| `pkb_aliases` | Other names for a brand, product, variant, family, definition or option | exactly one target; an approved alias means one thing per kind (per attribute for options) |
| `pkb_legacy_attribute_map` | Which definition mirrors each category specification | — |
| `pkb_unmapped_values` | Legacy values that could not be placed without guessing, with the reason | unique per listing and entry |
| `pkb_sync_queue` | Listings whose legacy columns changed since the mirror last read them | filled by triggers on the mirrored columns only — never price, stock or capacity |

**Links on existing tables** (nullable, `ON DELETE SET NULL`):
`products.pkb_product_id`, `product_variants.pkb_variant_id`,
`attributes.attribute_definition_id`, `categories.default_family_id`.

**Triggers that queue a listing:** product insert, and updates of title, brand,
identifier, details, attribute_values, spec_table, measurements, box_contents,
compliance or category; variant insert, delete or move; variant option value
changes; option and option-value renames; category moves. The migration queues
every existing listing.

**Encoding note.** The local PostgreSQL server runs WIN1252; migration text must
not contain characters outside it (arrows, for instance).

## Migration 0032 — Product intelligence (D-071 to D-076)

Adds the review, trust and retrieval tables. Brand status becomes
`active | merged | retired` with `merged_into_id`, so "this brand exists" and
"this brand's sources are trusted" are separate facts (A-9).

| Table | Holds | Rules the database enforces |
| --- | --- | --- |
| `pkb_source_registry` | A brand's domains, path prefixes and providers, with a role and an optional product-address template | the authority tier follows the role (1 official, 2 distributor/retailer/database/feed, 3 approved secondary, none for blocked); approved and rejected entries need a decider and a time; one entry per brand, kind, domain, path and provider |
| `pkb_brand_relations` | manufactured_by, subsidiary_of, formerly_known_as | no self-relation; one row per pair and kind; decisions recorded |
| `pkb_verification_policies` | What evidence is enough for VERIFIED: qualifying source types, registry roles, maximum tier, number of independent sources, whether AI-assisted extraction may count | active policies carry an activation time; the code seeds four (`lib/pkb/policies.ts`), one of them off by default |
| `pkb_label_mappings` | A reviewed decision that a written label is, or is not, an attribute | one approved decision per label, context and family; a mapping needs an attribute, an ignore must not name one; every row records who decided and when |
| `pkb_identifier_history` | created, updated, cleared, locked, unlocked — with before, after, actor or source, and a reason | append-only (trigger); the migration backfills a `created` row for every existing identifier |
| `pkb_enrichment_runs` | One requested run: status, request key, resolution state at the time, provider states, counts, blocked reason | request key unique, so a repeated request is one run; a blocked run records why |
| `pkb_source_documents` | What a run read or a person provided: status, refusal reason, HTTP status, size, hash, text, structured data, identity verdict | a refused document carries a reason; a retrieved one carries a hash |
| `pkb_product_sources` | The pages a person attached to a product | one row per product and source |
| `pkb_attribute_proposals` | A discovered label with an example value and its evidence | evidence required; a decided proposal records the actor, the time and what it became |
| `pkb_resolution_history` | Every change of a product's resolution state, with the reasons and the note | append-only |
| `pkb_identity_distinctions` | "This product is explicitly not that one" | no self-distinction; one row per pair |

**Columns added:** `pkb_evidence.document_id`; on `pkb_products` the resolution
state, when it was last checked, the reasons, and who decided it with when — a
VERIFIED resolution requires a person and a time.
