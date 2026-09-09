/**
 * Photographs used by the hero, and only by the hero.
 *
 * The catalogue's own imagery is drawn artwork on a pale studio ground. That is
 * fine at the size a product card shows it and thin at the size the hero does,
 * so a slide can be given a real photograph here without touching the product's
 * media: the card, the listing pages and the product page all go on showing the
 * catalogue image, and only the first screen changes.
 *
 * This is a presentation override, not a product record. The moment staff
 * upload real photography through the admin media tools, delete the entry and
 * the hero shows the real thing.
 */
export type HeroPhotograph = {
  url: string;
  alt: string;
  /**
   * A real photograph, framed edge to edge.
   *
   * The hero composes drawn artwork in two layers — a blurred wash for colour
   * and a masked subject beside the copy — because a square drawing on a pale
   * ground cannot fill a wide screen on its own. A photograph can, and putting
   * one through that treatment would blur and crop a picture that was already
   * composed by whoever took it.
   */
  photographic: boolean;
};

/**
 * By product slug. The entry below is a stand-in the owner supplied to see the
 * design carrying real photography.
 *
 * Two things about it are worth stating rather than discovering later: it
 * carries a visible copyright notice in its lower right corner, and it shows a
 * product from another brand. It is fine for looking at the design and it is
 * not licensed for this shop — replace it with photography of the actual goods
 * before this page is public.
 */
export const HERO_PHOTOGRAPHS: Record<string, HeroPhotograph> = {
  "sour-cherry-gummy-tin": {
    url: "/hero/fragrance-bottle.jpg",
    alt: "A glass bottle with a wooden cap, lit by hard afternoon light on a cherrywood surface.",
    photographic: true,
  },
};
