/**
 * The removable filter chips.
 *
 * Pure URL arithmetic, and worth its own tests because the failure modes are
 * quiet: a chip that drops the search along with the brand, a chip that leaves
 * the page number pointing past the end of a shorter result set, or a price
 * chip that removes one half of a range and leaves the other.
 */
import { describe, expect, it } from "vitest";
import { activeFilterChips } from "@/lib/catalog";

const labels = new Map([["11111111-1111-1111-1111-111111111111", "Sandstone"]]);

const chips = (params: Record<string, string | string[] | undefined>) =>
  activeFilterChips({ params, path: "/search", valueLabels: labels });

describe("active filter chips", () => {
  it("says nothing when nothing is filtering", () => {
    expect(chips({ q: "coffee", sort: "relevance" })).toEqual([]);
  });

  it("removes one brand and keeps the others", () => {
    const [first] = chips({ brand: ["Bellwether", "Cascade"] });

    expect(first.label).toBe("Bellwether");
    expect(first.href).toBe("/search?brand=Cascade");
  });

  it("keeps the search when a filter is removed", () => {
    const [chip] = chips({ q: "coffee", brand: "Bellwether" });

    expect(chip.href).toBe("/search?q=coffee");
  });

  it("drops the page number, because the results are about to change", () => {
    const [chip] = chips({ brand: "Bellwether", page: "3" });

    expect(chip.href).toBe("/search");
  });

  it("treats a price range as one chip that removes both bounds", () => {
    const [chip] = chips({ min: "1000", max: "5000" });

    expect(chip.label).toBe("BDT 1,000 – 5,000");
    expect(chip.href).toBe("/search");
  });

  it("names a one-sided price range for the side it has", () => {
    expect(chips({ min: "1000" })[0].label).toBe("From BDT 1,000");
    expect(chips({ max: "5000" })[0].label).toBe("Up to BDT 5,000");
  });

  it("labels an attribute value with its name rather than its id", () => {
    const [chip] = chips({ value: "11111111-1111-1111-1111-111111111111" });

    expect(chip.label).toBe("Sandstone");
    expect(chip.href).toBe("/search");
  });

  it("ignores an attribute value it cannot name", () => {
    // An id that is not in the current facets is one the listing is not
    // actually filtering by; a chip reading "22222222-…" would be worse than
    // no chip.
    expect(chips({ value: "22222222-2222-2222-2222-222222222222" })).toEqual([]);
  });

  it("removes the preorder filter in either spelling", () => {
    expect(chips({ preorder: "1" })[0]).toMatchObject({
      label: "Preorder only",
      href: "/search",
    });
    expect(chips({ fulfillment: "preorder" })[0].href).toBe("/search");
    expect(chips({ fulfillment: "in_stock" })[0].label).toBe("In stock only");
  });

  it("removes the availability filter", () => {
    expect(chips({ available: "1" })[0]).toMatchObject({
      label: "Available now",
      href: "/search",
    });
  });
});
