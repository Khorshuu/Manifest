import sanitizeHtml from "sanitize-html";

/**
 * The HTML a product description may contain (docs/SECURITY.md, D-057).
 *
 * Staff type descriptions as HTML in the editor, and they are rendered
 * as-is on the product page. The editor promised "paragraphs, headings, lists,
 * bold, italic and links", but nothing enforced it: any staff role with
 * catalogue access could store a script or an event handler that ran for every
 * shopper who opened the page. This is that promise, enforced by a parser
 * rather than regular expressions — which miss `javascript:` links, entities
 * and quoted angle brackets.
 *
 * Links keep only an http, https or mailto address and are marked
 * nofollow noopener, so a description cannot pass ranking to, or be opened in
 * the context of, another site.
 */
export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ["p", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em", "b", "i", "br", "a"],
    allowedAttributes: { a: ["href", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "nofollow noopener noreferrer" }),
    },
  }).trim();
}
