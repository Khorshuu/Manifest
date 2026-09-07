import { describe, expect, it } from "vitest";
import { formatBdt, taka } from "@/lib/money";

describe("money", () => {
  it("formats paisa as whole taka", () => {
    expect(formatBdt(250000)).toContain("2,500");
  });

  it("rejects non-integer paisa, since a fractional minor unit means a float leaked in", () => {
    expect(() => formatBdt(1234.5)).toThrow();
  });

  it("converts taka to paisa without floating point drift", () => {
    expect(taka(19.99)).toBe(1999);
    expect(taka(0.1 + 0.2)).toBe(30);
  });
});
