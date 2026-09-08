import { describe, expect, it } from "vitest";
import { slugify, uniqueSlug } from "@/lib/slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Seasonal Candy Variety Box")).toBe(
      "seasonal-candy-variety-box",
    );
  });

  it("strips punctuation and collapses separators", () => {
    expect(slugify("Ben & Jerry's — Half Baked!!")).toBe(
      "ben-jerry-s-half-baked",
    );
  });

  it("strips accents rather than dropping the letter", () => {
    expect(slugify("Crème Brûlée")).toBe("creme-brulee");
  });

  it("never starts or ends with a hyphen", () => {
    expect(slugify("  --hello--  ")).toBe("hello");
  });

  it("caps length so slugs stay usable in URLs", () => {
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe("uniqueSlug", () => {
  it("returns the base slug when it is free", async () => {
    await expect(uniqueSlug("Headphones", async () => false)).resolves.toBe(
      "headphones",
    );
  });

  it("appends a suffix until one is free", async () => {
    const taken = new Set(["headphones", "headphones-2"]);
    await expect(
      uniqueSlug("Headphones", async (candidate) => taken.has(candidate)),
    ).resolves.toBe("headphones-3");
  });

  it("falls back to a usable slug when the title has no slug characters", async () => {
    await expect(uniqueSlug("!!!", async () => false)).resolves.toBe("item");
  });
});
