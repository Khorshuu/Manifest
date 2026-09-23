/**
 * Stage 7: a write path that stores rich text without reducing it first.
 *
 * Two columns are rendered with `dangerouslySetInnerHTML` on the storefront —
 * `products.description_html` and `categories.intro_html`. Both are written by
 * staff, and staff are trusted to write copy, not to be a reason the safety of
 * every shopper's browser depends on nobody making a mistake (SECURITY.md,
 * D-057). Every path that stores either one passes it through a parser-backed
 * allow-list first.
 *
 * Today that is true. This test is the guard for the paths written later, in
 * the same shape as `pkb-write-paths.test.ts`: it reads the source and fails
 * when a file assigns one of those columns without a sanitiser in the same
 * expression. A source check, because the alternative — running every write
 * path that has not been written yet — is not something a test can do.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeRichText } from "@/lib/html/rich-text";

const LIB = join(process.cwd(), "lib");

/** The columns that reach `dangerouslySetInnerHTML` on a storefront page. */
const RENDERED_AS_HTML = ["descriptionHtml", "introHtml"];

/** Any call whose name says it reduces HTML to something storable. */
const SANITISER = /sanitize[A-Za-z]*(RichText|DescriptionHtml|Html)?\s*\(/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return entry.endsWith(".ts") ? [path] : [];
  });
}

describe("storing text that is rendered as HTML", () => {
  it("passes every write through the allow-list", () => {
    const offenders: string[] = [];

    for (const path of sourceFiles(LIB)) {
      const source = readFileSync(path, "utf8");
      for (const column of RENDERED_AS_HTML) {
        // A property (`column:`) or an assignment (`column =`), never a
        // comparison — `=(?!=)` is what keeps `=== undefined` out.
        const assignment = new RegExp(`\\b${column}\\s*(?::|=(?!=))\\s*([^,;\\n}]+)`, "g");
        for (const match of source.matchAll(assignment)) {
          const value = match[1].trim();
          // Three things name the column without storing anything: a
          // selection, which names it on both sides; a type or validation
          // schema, which declares its shape; and a label map, whose value is
          // a string literal. Everything else is treated as a write.
          //
          // Every exclusion is anchored, deliberately. An unanchored one is
          // how this guard stops guarding: `\|\s*null` written to match the
          // type `string | null` also matches the tail of
          // `input.descriptionHtml || null`, which is exactly the write it
          // exists to catch.
          if (/^(products|categories)\.\w+$/.test(value)) continue;
          if (/^(string|boolean|number)\s*(\|\s*null\s*)?$/.test(value)) continue;
          if (/^(z\.|clearableText\()/.test(value)) continue;
          if (/^["'`]/.test(value)) continue;
          if (SANITISER.test(value)) continue;
          offenders.push(`${path.slice(process.cwd().length + 1)}: ${column}: ${value}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the allow-list actually removes what it promises to", () => {
    // Not a substitute for `tests/security.test.ts`, which covers the
    // sanitiser properly — this is here so the guard above cannot pass by
    // pointing at a function that does nothing.
    const dangerous = `<p>Fine</p><script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">x</a>`;
    const cleaned = sanitizeRichText(dangerous);

    expect(cleaned).toContain("<p>Fine</p>");
    expect(cleaned).not.toContain("script");
    expect(cleaned).not.toContain("onerror");
    expect(cleaned).not.toContain("javascript:");
  });
});
