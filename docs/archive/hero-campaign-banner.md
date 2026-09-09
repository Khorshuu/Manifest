# Archived hero: the bright campaign banner

The home page hero in place for commit `d8a41eb` only: a bright, full-bleed
promotional band on `paper` — headline and batch details in a left column, the
product photograph in a bordered plate on the right, a rotated brass sticker on
its outer corner, circular arrows on the outer edges of the band, and a strip of
four square thumbnails doubling as the position indicator. Under it a ruled
paper texture, a warm bloom breathing on a sixteen-second cycle, and the solid
`blue-600` navigation bar above it.

Replaced by the immersive editorial hero: one photograph filling the first
screen, the header floating inside it with no bar of its own and adapting to how
light each slide is, and the featured products lifted onto the foot of the
image. That change was asked for directly, and its reasoning is in
`docs/PROGRESS.md`.

Kept here because it is a complete, working idea. Nothing in this file is
compiled or linted.

## To restore it

```
git checkout d8a41eb -- components/hero-backdrop.tsx components/hero-carousel.tsx components/header-shell.tsx components/site-header.tsx components/search-box.tsx app/globals.css "app/(storefront)/layout.tsx" "app/(storefront)/page.tsx"
```

That takes the header back with it, which is deliberate: the blue bar and the
banner were designed against each other, and restoring one without the other
gives a page that belongs to neither design.

## What was worth keeping from it

Three things survived into the hero that replaced it, and they are the parts
that were about the shop rather than about the decoration:

- The four facts a preorder shopper is deciding on — what it is, what it costs,
  how long the window stays open, how many places are left — stated in the hero
  itself rather than on the product page only.
- One loud call to action, with the second route out of the hero as a quiet
  link rather than a second button competing for the same press.
- The next row of products butting straight up underneath, so the page reads as
  a shop rather than as a landing page with a shop below it. The new hero takes
  this further: the row overlaps the foot of the photograph.

## What was not

The bordered plate. A photograph in a frame on a page is an illustration of a
product; a photograph filling the screen is the product. Every hero before this
one kept the picture inside something, and that is the single change that made
the first screen feel like a shop worth buying from.
