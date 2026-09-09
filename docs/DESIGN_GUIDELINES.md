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
- Borders first: 1px `blue-300` is the default separator between sections, table rows, and card
  edges. Shadow is added on top of the border, never instead of it.

### Depth
The original brief said borders and never shadows. That produced a page where nothing had any
hierarchy, so there is now a four-step scale, defined once in `app/globals.css` and referenced
by token everywhere. It stays cool-toned and tight rather than the soft grey blur that makes
every card look the same.

| Token | Where |
|---|---|
| `--shadow-raise` | The resting state of any card, panel, table or tile. |
| `--shadow-lift` | What a card moves to under the pointer, and the resting state of a panel that carries the main action on a screen (a cart or checkout summary). |
| `--shadow-float` | Things genuinely above the page: the hero photograph, a search dropdown. At most one per screen. |
| `--shadow-brass` | The call to action on hover, and nothing else. |

Depth carries hierarchy: only things that lift get a shadow, and the amount says how far. Two
elements at `float` on one screen means neither is floating.

### Signature pattern: the immersive hero
The home page opens on one photograph, not on a banner. The stage fills 84–90% of the first
screen; the header is drawn inside it; the featured products are lifted onto its bottom edge so
the three read as a single composition. Built in `components/hero-showcase.tsx`.

The image is composed in two layers taken from the same photograph, which is what lets a square
catalogue shot fill a wide screen without being cropped to a stripe of itself:

| Layer | What it does |
|---|---|
| `.hero-wash` | The photograph, blurred and scaled past every edge. It gives the whole screen the product's own colour. |
| `.hero-subject` | The same photograph, sharp, held beside the copy. Feathered with a **circle** mask (an ellipse sized to the box leaves the picture's own vertical edges showing as a hard line) and blended into the ground so its studio backdrop does not read as a pasted rectangle. |
| `.hero-grade` | Warm light out of the top right, cool shade into the lower left, multiplied. Turns an evenly lit catalogue picture into a lit scene, in the brand's own brass and blue. |
| `.hero-scrim` | The only overlay, and directional: it comes out of the corner the words are in. A flat scrim over the whole image darkens the product, which is the one thing worth looking at. |
| `.hero-grain` | Film grain at 14%. Stops a large gradient banding and gives generated artwork the texture of a photograph. |

Copy sits low and left in a column capped at 34rem. Below `lg` the subject moves above the
words; on a phone it is dropped altogether, because a phone screen is exactly as tall as the
words need and a subject anywhere on it lands behind the headline.

Photography should be real product shots (the actual American goods, styled plainly) — never
stock lifestyle imagery. Until real photography exists the drawn artwork stands in, and the
composition above is what makes it hold a full screen.

### Signature pattern: the adaptive header
No solid rectangle of brand colour. Two states, one component (`components/header-shell.tsx`):

- **Floating.** Over a hero the header has no bar at all — wordmark, categories, search, account
  and cart drawn directly on the photograph, over a veil thin enough to be felt rather than
  seen. The routes this applies to are listed in `OVERLAY_ROUTES` in `header-theme.tsx`.
- **Bar.** Everywhere else, and on the home page once the photograph has scrolled away: white,
  a `blue-300` hairline, ink lettering, `--shadow-raise`.

Over a hero the header takes the **opposite** treatment to the imagery: navy over a bright
slide, pale over a dark one. It is measured rather than guessed — `lib/hero-tone.ts` reads the
average relative luminance of each slide's image off a canvas, and `HERO_TONE_OVERRIDES` in the
same file lets whoever chose a photograph state the answer where the average gets it wrong (an
image that is mostly dark with a bright sky exactly where the navigation sits). The hero reports
what it measured through `components/header-theme.tsx`; the header only reacts, and every colour
in it is a CSS variable so the whole bar crossfades in one movement rather than element by
element.

Contrast over a photograph cannot be checked by axe — it reports "incomplete" wherever a
background image is involved — so it is measured from the rendered pixels instead. At the last
pass, on the seeded catalogue: nav links 6.4:1, account 10.8:1, wordmark 15.7:1, hero body copy
6.6:1, headline 15.4:1.

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

## Shared components

Anything that appears on more than one screen is defined once. This section exists because it
was not true: at one point 41 separate places hand-wrote
`inline-flex min-h-11 items-center rounded-control border border-blue-300 px-4 …`, and they
quietly disagreed about padding, weight, hover and press. That inconsistency, more than any
single screen, is what made the quieter pages look unfinished beside the storefront.

| Component | Use it for |
|---|---|
| `components/button.tsx` | `Button` for actions, `LinkButton` for links that read as buttons. Four variants (`primary`, `secondary`, `quiet`, `danger`), three sizes. `buttonClass()` exports the recipe for the rare case that needs a bare element. Never hand-write a control. |
| `components/panel.tsx` | `Panel` is the boxed surface — card radius, border, optional depth. `SectionHeading` is the brass-ruled heading for a band inside a page. |
| `components/page-heading.tsx` | The `h1` version of the same heading. One per page. |
| `components/empty-state.tsx` | Every "there is nothing here" on the site: a drawn mark, a title, a sentence saying why, and a way out. |
| `components/icons.tsx` | The whole icon set. 24×24 grid, 1.5 stroke, `currentColor`, decorative unless given a `title`. |
| `components/skeleton.tsx` | Loading states, shaped like the content they stand in for. |
| `components/status-badge.tsx` | Any status. Outlined, never a filled pill. |

### Icons
Single-line, drawn in `components/icons.tsx` rather than pulled from a library: they cost
nothing at runtime against the JavaScript budget, they carry the shipping-document identity
(square corners, ruled lines, a customs seal) instead of a generic app language, and one file
guarantees the stroke width, cap and grid are identical everywhere.

Never use a typographic character as an icon — `→`, `←`, `★` and `·` render at a different
weight in every face and were the one place the icon language came from the typeface. Never use
an emoji.

## Motion

The original brief allowed exactly one animated moment on the whole site. The product owner
looked at the result and rejected it as generic, so the brief is overridden: movement, hover
states, sliders and countdowns are wanted. Two constraints did *not* move and are not
negotiable — every page keeps passing the axe audit at AA, and everything here is switched off
by `prefers-reduced-motion`, which for some people is the difference between a usable page and
nausea.

- **Entrances** come from `components/motion.tsx`. An entrance may never be the reason something
  cannot be read: it hides only what is genuinely below the fold, plays once, and touches
  nothing at all when reduced motion is asked for.
- **The pointer is always answered.** `.lift` is the one definition for a surface that responds
  — a catalogue card, an order row, an admin tile all move by the same amount. Under reduced
  motion the border and shadow still change; only the movement goes.
- **Presses land on the first frame.** Every control sinks slightly (`active:scale-[0.985]`),
  in CSS, so it does not wait for JavaScript.
- **Loud moments are rationed.** The split-flap countdown, the hero, and the stamp when an order
  status advances. Three on the whole site; a fourth would make all four read as decoration.
- **Continuous motion must be stoppable** and reachable without a pointer (WCAG 2.2.2) — see the
  manifest strip's Hold button, and the hero's progress hairline, which pauses with the rotation
  under the pointer, on focus, and for good once anyone chooses a slide by hand.
- **The hero's vocabulary**, in full: a 900ms crossfade between slides, a 24-second drift across
  the wash, a 1.2-second settle on the subject, the copy rising in on a stagger, the cards
  entering 70ms apart, the header crossfading between treatments over 500ms, and the active card
  lifting 2px. Every one is slow and large. Three heroes have been rejected here for small, fast,
  faint movement, and the lesson holds: **scale beats incident.**
- Prefer CSS. Framer Motion is imported only where a spring or an exit animation genuinely earns
  it (cart line removal, the hero slide change), because the home page is measured against a
  200KB gzipped JavaScript budget.

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
