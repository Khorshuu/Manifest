# MASTER PRODUCT SPEC — US-to-Bangladesh Preorder Storefront

## Business Model
A preorder-based e-commerce site for niche American products that are hard to find or
overpriced in Bangladesh. There is no live inventory in the traditional sense — the operator
sources products after demand/payment is confirmed. Customers preorder; there is no public
seller/vendor marketplace. Only the operator (Super Admin) and internal team (Staff) can
create or edit product listings and media — this is enforced server-side, not just hidden in
the UI.

## 1. User Roles & Permissions
- **Super Admin** — full access: products, orders, users, staff roles, site settings, analytics,
  financials.
- **Staff Admin** — can upload/edit products, manage preorder status, process orders; cannot
  manage other admins, financial settings, or site-wide config unless explicitly granted.
- **Customer** — browse, search, wishlist, preorder, track orders, review, manage profile/addresses.
  Cannot create listings or upload product media under any circumstance.

## 2. Product Catalog & Variations
- Nested categories (at least 3 levels: Category → Subcategory → Sub-subcategory).
- Flexible, non-hardcoded attribute system — not just size+color. Admin can define arbitrary
  attribute types (color, size, material, storage, edition, bundle, compatibility, etc.),
  generate all combinations, disable unwanted combinations, then edit each variant individually
  or in bulk.
- Each variant has its own: SKU, price (or price delta from base), preorder capacity, images,
  weight/dimensions, availability status.
- Product-level fields: title, brand, rich-text description, bullet features, spec table, tags,
  SEO fields (meta title/description/slug).
- Preorder fields: estimated arrival window, preorder capacity, deposit-vs-full-payment toggle,
  closing date.
- Status states: In Stock, Preorder Open, Preorder Closed/Sold Out, Coming Soon, Discontinued,
  Draft, Scheduled, Archived.
- Related products / "frequently bought together" / "customers also viewed."

## 3. Inventory & Preorder Engine (core of the business)
- Model stock as preorder slots/capacity, not physical inventory.
- Track: capacity, reserved, remaining, waitlist once capacity is hit.
- All capacity checks happen server-side inside a transaction — no overselling, no race
  conditions on the last slot.
- Preorder lifecycle: opening → closing (by date or capacity) → extension → cancellation →
  refund. Handle "preorder closes while item is still in someone's cart" gracefully.

## 4. Admin Dashboard
- Overview: revenue, pending preorders, low-capacity alerts, recent orders, top products —
  all figures from real data, never hardcoded.
- Product management: step wizard (Basic Info → Images → Variations → Pricing/Capacity → SEO →
  Publish), bulk edit, draft/scheduled/published/archived states, preview before publish.
- Order pipeline: Placed → Payment Confirmed → Sourcing → Shipped from US → In BD Customs/Transit
  → Out for Delivery → Delivered, with Cancelled/Refunded as alternate paths. Manual tracking
  updates and internal notes per order.
- Customer management, staff/role management, exportable reports (CSV).
- Audit log for sensitive admin actions (price changes, capacity changes) recording user,
  action, before/after values, timestamp.

## 5. Customer Storefront
- Homepage: hero/carousel, featured categories, trending preorders, new arrivals, slot-scarcity
  indicators, newsletter signup.
- Search with autosuggest; filters by category/price/brand/attribute; sort options.
- PLP/PDP pages with Amazon-level information density but a distinct, premium visual identity
  (not Amazon's navy/orange palette).
- Cart, wishlist, account area (order history/tracking, addresses, wishlist, reviews).
- Checkout (multi-step: Cart → Address → Payment → Confirmation) with selectable payment method
  UI for bKash, Nagad, Rocket, card (via SSLCommerz or similar), bank transfer, and
  cash-on-delivery/deposit — backed by a mock payment provider until real gateways are wired in.
  Every step must make clear to the customer: what they're buying, which variant, how much
  they're paying (deposit vs full), and when to expect it.
- Reviews restricted to verified/delivered purchases.

## 6. Cross-Cutting Requirements
- All pricing, discounts, and totals recalculated server-side — client never dictates price.
- Payment/shipping/notification providers behind an abstraction layer, with mock
  implementations usable before real credentials exist.
- File uploads: validate type/size, sanitize filenames, no executable uploads, generate
  optimized image sizes.
- Fully responsive, mobile-first (most traffic will be mobile), accessible (contrast, focus
  states, semantic HTML).
- SEO: metadata, canonical URLs, structured data, sitemap — must not break with dynamic routing.

## 7. Explicitly Out of Scope for MVP (defer, but design for)
- Real payment gateway credentials (use mock provider).
- Real courier/tracking API integration (build the abstraction, mock the implementation).
- Advanced/fuzzy/semantic search (start with reliable DB-backed search).