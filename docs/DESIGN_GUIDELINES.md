# Design Guidelines — Import Manifest Visual System

## Concept
This is a preorder storefront for American goods crossing into Bangladesh. The visual language
borrows from **shipping manifests, customs stamps, and transit documentation** — not from Amazon,
not from a generic SaaS kit. Every recurring UI pattern (status badges, tracking, spec tables)
should feel like it belongs on a real shipping document, quietly translated into a modern
storefront.

This is deliberately *not*: cream-background/terracotta-accent AI-default, all-caps tracked
eyebrows, arrow-suffixed buttons, identical rounded cards with soft grey shadows.

---

## Color

Primary canvas is white — this is a shopping site, and product photography needs to sit on a
clean, neutral ground the way it does on any well-run ecommerce store. The blue ramp becomes the
brand accent (nav, buttons, links, active states, borders) rather than the page background.

| Token | Hex | Role |
|---|---|---|
| `ink` | `#12233F` | Primary text, headings |
| `blue-600` (brand) | `#2F6FED` | Nav bar, primary buttons, links, logo mark |
| `blue-500` | `#4C8DFF` | Hover states, secondary accents |
| `blue-400` | `#8AB4FF` | Icon strokes, chart lines |
| `blue-300` | `#BBD3FF` | Borders, dividers, input borders |
| `blue-200` | `#DCE9FF` | Tag backgrounds, table zebra stripes, subtle section fills |
| `blue-50` | `#F2F7FF` | Very light section backgrounds (used sparingly to separate zones) |
| `white` | `#FFFFFF` | Default page background, cards, product tiles |
| `brass` | `#F0A631` | CTA accent — preorder/add-to-cart buttons, price emphasis |
| `transit-green` | `#2FA36E` | Confirmed / shipped / delivered / in-stock states |
| `stamp-red` | `#EF4F42` | Sold out, closing soon, errors |

Rules:
- Default every page to `white`. Use `blue-50` only to visually separate one band from the
  next (e.g. a features strip between the hero and the product grid) — never as the base
  canvas, and never two `blue-50` bands in a row.
- `blue-600` is the brand color: it's what makes the nav, logo, and buttons read as "this
  brand," the way a fish importer's site uses its brand blue in the header and nowhere else
  aggressively.
- `brass` stays the CTA accent so "preorder" and "add to cart" don't get lost against a blue
  nav and blue links.
- The saturated three (`brass`, `transit-green`, `stamp-red`) are fills, borders and icons.
  They are too light to read as small text on paper — measured at 2.06:1, 3.19:1 and 3.58:1
  against white — so each has a darker partner for wherever the colour becomes words:
  `brass-text` `#8A5A00`, `transit-green-text` `#1E7A50`, `stamp-red-text` `#C62F24`. A badge
  keeps the vivid border and takes the darker text; the identity is unchanged and the label is
  readable. `blue-600` is `#2563EB` for the same reason — the original `#2F6FED` cleared AA on
  white by 0.05 and failed on any tinted ground.
- Muted text stops at `ink/70` (5.90:1). `ink/60` reads as perfectly fine grey and measures
  4.27:1, which is why this is a rule rather than a matter of taste — see the accessibility
  baseline in PROGRESS.md.
- No dark full-bleed sections as a default pattern — reserve deep `blue-600`/`ink` backgrounds
  for at most one small section on the whole homepage (see below), not the general system.

## Type

- **Display / headlines**: Fraunces (serif) — used for product titles, section headers, the
  hero. Set with slightly tight tracking at large sizes. This is the one place the brand shows
  personality; don't dilute it by also using it for body copy or UI labels.
- **UI / body / data**: Inter (grotesk sans) — everything else: nav, buttons, forms, tables,
  prices, admin dashboard, product specs.
- Two typefaces total. No monospace anywhere unless displaying an actual SKU/tracking code,
  where a monospace numeral is functionally justified.

Scale (base 16px):
| Level | Size / Line-height | Weight | Typeface |
|---|---|---|---|
| Display | 48px / 1.1 | 600 | Fraunces |
| H1 | 34px / 1.2 | 600 | Fraunces |
| H2 | 24px / 1.3 | 600 | Fraunces |
| H3 | 19px / 1.4 | 600 | Inter |
| Body | 16px / 1.6 | 400 | Inter |
| Small / meta | 13px / 1.5 | 400–500 | Inter |
| Price | 20px / 1.2 | 600 | Inter |

Line length: cap body text around 70ch. No all-caps labels — use sentence case with color/weight
for emphasis instead.

## Layout

- Left-aligned throughout. No centered hero text, no centered marketing blocks.
- Grid: 12-column on desktop, 4-column on mobile, 24px gutter.
- Spacing scale (px): 4, 8, 12, 16, 24, 32, 48, 64, 96 — pick from this scale only.
- Radius: two values only. `4px` for buttons/inputs/small controls, `2px` for cards/images
  (barely-rounded, closer to a printed document corner than a soft app card). Never fully
  pill-shaped buttons.
- Borders over shadows: 1px `blue-300` is the default separator between sections, table rows,
  and card edges.

### Signature pattern: photography-led hero
Full-bleed product photography on the right half of the hero, headline set in Fraunces on the
left on `white`, a small vertical numbered index (`01`, `02`) running down the far-left edge to
mark hero slides if there's more than one. A single scroll cue at the bottom-left, no more.
Photography should be real product shots (the actual American goods, styled plainly) — never
stock lifestyle imagery.

### Signature pattern: brand header
A confident nav bar in `blue-600` (or white with a `blue-600` logo mark and text) — logo left,
primary nav center or right, cart/account icons far right. This is the single place the brand
blue is allowed to dominate visually; it anchors the identity the way a shipping company's
header does, without needing to color the rest of the page.

### Signature pattern: light feature strip
Between the hero and the product grid, one `blue-50` band holds 3–4 short trust points (e.g.
"Sourced direct from the US," "Fixed preorder windows," "Tracked door to door") each with a thin
line icon. This is the only place `blue-50` is used, and only once per page.

### Signature pattern: icon category row
A horizontal row of simple single-line icons (not filled/colored illustrations) with a label
underneath, used for category navigation on the homepage ("Snacks," "Home goods," "Apparel,"
"Electronics"). Icons in `ink`, label in Inter 13px, no background shape behind the icon —
they float directly on `paper`.

### Signature pattern: the transit line
Order tracking and preorder pipeline status use a **horizontal dotted line with stamp-style
nodes** (square, not circular — like a manifest checkpoint), not a generic rounded progress bar.
Each passed checkpoint gets a small ink or transit-green square with the date; future
checkpoints are hollow outline squares in `blue-400`.

### Signature pattern: the manifest table
Product specifications and variant matrices render as a bordered ledger table — alternating
`blue-200` row stripes, right-aligned numeric columns, a header row in `ink` on `paper`. This
same component is reused for admin inventory/variant tables so customer and admin visually
belong to the same system.

### Status badges
Square-cornered (2px radius) badges with a 1px border in the semantic color and text in the
same color on a transparent/paper background — not solid filled pills. E.g. "Preorder open" in
brass outline, "Sold out" in stamp-red outline, "Delivered" in transit-green outline.

## Motion
One deliberate moment only: when an order status advances, the new checkpoint square fills in
with a brief (200ms) stamp-down animation (scale 1.15 → 1, opacity fade). No scroll-triggered
fade-ups on every section, no hover-lift on every card. Buttons get a simple 100ms background
transition on press; that's it.

## Voice & copy
- Plain, direct, active voice. "Track your order," not "Order Tracking Portal."
- Preorder transparency is a design requirement, not just a legal one: every product and cart
  line must make explicit what's being bought, which variant, how much (deposit vs. full), and
  the estimated arrival window — stated plainly, not buried in fine print.
- Empty states and errors explain what happened and what to do next, in the interface's voice:
  "This variant is sold out — join the waitlist," not "Error: stock unavailable."
- No filler marketing language ("premium," "exclusive," "best-in-class") — let the product and
  the transparent pricing/timeline speak for itself.

## Accessibility floor
- Text contrast meets WCAG AA against `paper` and `paper-raised` at minimum.
- Visible keyboard focus ring on every interactive element (2px `brass` outline, 2px offset).
- All status information (badges, tracking) is conveyed by shape + text label, not color alone.
- Respect `prefers-reduced-motion` — disable the stamp-down animation and any transitions beyond
  opacity when set.
