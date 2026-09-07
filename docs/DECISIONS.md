# Decisions

Architecture decision log. One entry per meaningful choice, newest first. Each entry states the decision, the alternatives considered, and why the decision won — so a later session can revisit it without re-deriving the reasoning from scratch.

---

## D-007: `paper` and `paper-raised` aliased to white and blue-50

**Decision:** `app/globals.css` defines `--color-paper: #ffffff` and `--color-paper-raised: #f2f7ff`.

**Why:** DESIGN_GUIDELINES.md refers to `paper` and `paper-raised` in its accessibility floor and in two signature-pattern descriptions, but its color table defines neither — the table names `white` and `blue-50` instead. Rather than leave the tokens undefined and let each component invent its own, they're aliased to the two values the surrounding prose clearly intends. This is a reading of an inconsistency in the guidelines, not a design decision, and should be confirmed with whoever owns the design system; if the intended `paper` is an off-white rather than pure white, only these two token values change and nothing else in the codebase does.

## D-006: Attribute system uses EAV (entity-attribute-value), not fixed columns

**Decision:** Product variation is modeled as `attributes` / `attribute_values` / `variant_option_values`, not as fixed `size` and `color` columns on the variant table.

**Why:** MASTER_PRODUCT_SPEC.md §2 requires admins to define arbitrary attribute types (color, size, material, storage, edition, bundle, compatibility, ...) and generate combinations from them. Fixed columns cannot express an admin-defined attribute set. EAV costs query complexity (variant lookup by attribute needs joins) but that cost is paid once in `lib/catalog/` and is worth it against the alternative of a schema migration every time a new attribute type appears.

## D-005: Preorder capacity lives on the variant, not a separate cross-product batch entity

**Decision:** `preorder_capacity`, `preorder_reserved`, and `preorder_closes_at` are columns on `product_variants`. There is no shared "sourcing batch" entity spanning multiple products.

**Why:** MASTER_PRODUCT_SPEC.md §3 describes preorder as slots/capacity per listing, not a cross-product run. An earlier draft of this spec (superseded) modeled a shared batch entity; the current spec doesn't call for it, and inventing one would be exactly the kind of complexity §9 warns against. If a future requirement needs to group variants into a shared US purchase run, add a `sourcing_runs` table then, against a real need.

## D-004: Payments and shipping go behind a provider interface with a mock implementation

**Decision:** `lib/providers/payment` and `lib/providers/shipping` define an interface; a mock implementation satisfies it until SSLCommerz and a courier/tracking integration have real credentials.

**Why:** MASTER_PRODUCT_SPEC.md §6 and §7 require this explicitly, so the app is runnable and testable end to end before external accounts exist. SSLCommerz is the assumed primary gateway (aggregates card, bKash, Nagad, Rocket) because it's the standard Bangladesh payment aggregator; if the business instead integrates bKash/Nagad directly, only the provider implementation changes, not the call sites.

## D-003: PostgreSQL with Drizzle ORM, not Prisma

**Decision:** PostgreSQL, accessed through Drizzle with checked-in SQL migrations.

**Why:** The preorder capacity check (§7: "no overselling / no over-preordering") is the highest-risk piece of correctness in this system, and it must run as a `SELECT ... FOR UPDATE` or equivalent inside an explicit transaction. Drizzle stays close to SQL and makes that transaction visible and reviewable in the query itself. Postgres gives real transactions and constraints, which a capacity engine and a financial audit log both need.

## D-002: Session-based auth with a hand-rolled sessions table, not an auth-as-a-service library

**Decision:** Password hashing (argon2id) plus a `sessions` table referenced by a signed HTTP-only cookie. No NextAuth/Auth.js, no third-party auth provider.

**Why:** There are exactly three roles (`super_admin`, `staff_admin`, `customer`) with server-enforced, per-route authorization (§7), and admin actions must write to an audit log tied to the acting session. A general-purpose auth library adds an abstraction layer between the session and that authorization logic for no benefit at this scale. Revisit if social login or SSO becomes a real requirement.

## D-001: Next.js (App Router) with TypeScript, Tailwind, Vercel + Neon Postgres

**Decision:** Next.js App Router, TypeScript strict mode, Tailwind CSS driven by the DESIGN_GUIDELINES.md token set, deployed to Vercel with Neon for serverless Postgres, Cloudflare R2 for product imagery.

**Why:** MASTER_PRODUCT_SPEC.md §6 requires SEO (metadata, structured data, sitemap) and a fast mobile-first storefront, which favors server-rendered pages over a client-only SPA. The same app serves the customer storefront and the internal admin dashboard, which keeps deployment and auth code in one place. Neon's branching model gives each phase of work an isolated database without standing up separate Postgres instances by hand. Cloudflare R2 is chosen over storing images in Postgres or in the app's own filesystem because Vercel's serverless runtime has no persistent disk, and R2's egress pricing suits an image-heavy storefront.
