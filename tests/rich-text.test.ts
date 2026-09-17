/**
 * Product description HTML (lib/html/rich-text.ts): the formatting the editor
 * offers survives; scripts, handlers, styles, frames and dangerous link
 * schemes do not, however they are spelled.
 */
import { describe, expect, it } from "vitest";
import { sanitizeRichText } from "@/lib/html/rich-text";
import { jsonLdScript } from "@/lib/seo";

describe("sanitizeRichText", () => {
  it("keeps the formatting the editor offers", () => {
    const html = '<h3>Box</h3><p>A <strong>big</strong> <em>box</em>.</p><ul><li>One</li></ul><a href="https://example.com/a">link</a>';
    expect(sanitizeRichText(html)).toBe(
      '<h3>Box</h3><p>A <strong>big</strong> <em>box</em>.</p><ul><li>One</li></ul><a href="https://example.com/a" rel="nofollow noopener noreferrer">link</a>',
    );
  });

  it.each([
    ["script", "<p>Hi</p><script>alert(1)</script>", "<p>Hi</p>"],
    ["event handler", '<p onclick="steal()">Hi</p>', "<p>Hi</p>"],
    ["image error handler", '<img src=x onerror="steal()">', ""],
    ["javascript link", '<a href="javascript:steal()">x</a>', "<a rel=\"nofollow noopener noreferrer\">x</a>"],
    ["encoded javascript link", '<a href="jav&#x61;script:steal()">x</a>', "<a rel=\"nofollow noopener noreferrer\">x</a>"],
    ["protocol-relative link", '<a href="//evil.example">x</a>', "<a rel=\"nofollow noopener noreferrer\">x</a>"],
    ["iframe", '<iframe src="https://evil.example"></iframe><p>ok</p>', "<p>ok</p>"],
    ["style", "<style>body{display:none}</style><p>ok</p>", "<p>ok</p>"],
    ["svg", "<svg onload=steal()><p>ok</p></svg>", "<p>ok</p>"],
    ["closing a script early", '<p title="</p><script>alert(1)</script>">x</p>', "<p>x</p>"],
  ])("removes %s", (_name, input, expected) => {
    expect(sanitizeRichText(input)).toBe(expected);
  });

  it("escapes stray angle brackets instead of letting them start markup", () => {
    expect(sanitizeRichText("<p>5 < 6 and 7 > 3</p>")).toBe("<p>5 &lt; 6 and 7 &gt; 3</p>");
  });
});

describe("jsonLdScript", () => {
  it("cannot be closed early by content containing </script>", () => {
    const serialised = jsonLdScript({ name: "Box </script><script>alert(1)</script>" });
    expect(serialised).not.toContain("</script>");
    expect(JSON.parse(serialised)).toEqual({ name: "Box </script><script>alert(1)</script>" });
  });
});
