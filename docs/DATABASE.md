# Database

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
  description_html    text
  bullet_features      jsonb                 -- string[]
  spec_table          jsonb                 -- [{ label, value }]
  seo_meta_title       text
  seo_meta_description text
  status              text not null check (status in
                       ('draft','scheduled','in_stock','preorder_open',
                        'preorder_closed','coming_soon','discontinued','archived'))
  publish_at          timestamptz           -- for 'scheduled'
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
  sort_order          int not null default 0

product_related
  product_id          uuid not null references products(id)
  related_product_id  uuid not null references products(id)
  kind                text not null check (kind in ('related','frequently_bought_together'))
```

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
- Full-text search index on `products (title, brand)` for v1 search; see MASTER_PRODUCT_SPEC.md §7 — fuzzy/semantic search is explicitly deferred.

## Open schema questions

- Exact deposit/balance flow: does a `payment_mode = 'deposit'` order automatically get a second `payments` row created when the batch ships, or does staff trigger that manually from the admin order screen? Affects whether `orders` needs a `balance_due_bdt` column now or later.
- Whether `waitlist_entries` needs a `notified_at`-driven automatic re-offer when capacity frees up (a cancellation), or staff handle it manually for v1.
