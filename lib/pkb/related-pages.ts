import { Parser } from "htmlparser2";
import { onDomain } from "@/lib/providers/research/query";

/**
 * The few pages a product page links to that say more about the same product
 * (D-124): its specifications, technical details, support, manual or
 * documentation page. Found only on a page already matched to this product,
 * followed one level only (never from a related page), and at most a few.
 *
 * Only links on the same site, whose address or text says what they are, and
 * that look tied to this product — the address shares a word with the
 * product page's own address or with the product's identity. A site-wide
 * "Support" link in a header is not about this product and is not followed.
 * Reviews, blogs, news, categories, carts, accounts, promotions and social
 * links never are. A followed page is still retrieved through robots.txt and
 * `safeFetch`, and still has to match the product by `identityVerdict` before
 * anything it says is used.
 */

export const MAX_RELATED_PAGES = 3;

const USEFUL = /(spec|specification|technical|tech-?specs|datasheet|data-sheet|support|manual|user-?guide|documentation|docs|product-?details|product-?info|details|features|ingredients|how-?to-?use|instructions|faq)/i;
const NEVER =
  /(review|rating|blog|news|article|press|stories|story|categor|collection|\/c\/|tag\/|author|account|cart|basket|checkout|log-?in|sign-?in|register|wishlist|compare|promo|sale|deal|offer|coupon|gift|career|jobs|privacy|terms|cookie|contact|store-?locator|where-?to-?buy|search|share|subscribe|newsletter|affiliate|recommend|similar|related-?products|you-?may-?also)/i;
const NOT_A_PAGE = /\.(pdf|jpe?g|png|gif|webp|svg|mp4|mov|zip|exe|dmg|docx?|xlsx?)(\?|$)/i;
/** Words that tie nothing to a product. */
const GENERIC = new Set(["www", "com", "html", "htm", "php", "aspx", "en", "us", "gb", "products", "product", "shop", "store", "support", "spec", "specs", "specifications", "details", "manual", "manuals", "docs", "page", "pages", "index", "home"]);

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !GENERIC.has(token));
}

export type RelatedLink = { url: string; text: string };

export function relatedPageLinks(
  html: string,
  pageUrl: string,
  identityTokens: string[],
  limit = MAX_RELATED_PAGES,
): RelatedLink[] {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  const site = page.hostname.replace(/^www\./, "");
  const pageTokens = new Set(tokens(page.pathname));
  const identity = new Set(identityTokens.flatMap(tokens));

  const found: RelatedLink[] = [];
  const seen = new Set<string>([`${page.origin}${page.pathname}${page.search}`]);
  let href: string | null = null;
  let text = "";
  let depth = 0;

  const consider = (rawHref: string, anchorText: string) => {
    if (found.length >= limit) return;
    let url: URL;
    try {
      url = new URL(rawHref, page);
    } catch {
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    if (url.username || url.password) return;
    if (!onDomain(url.hostname, site)) return;
    if (page.protocol === "https:" && url.protocol === "http:") return;
    url.hash = "";
    const key = `${url.origin}${url.pathname}${url.search}`;
    if (seen.has(key)) return;
    const label = anchorText.replace(/\s+/g, " ").trim().slice(0, 120);
    const described = `${url.pathname} ${url.search} ${label}`;
    if (NOT_A_PAGE.test(url.pathname) || NEVER.test(described) || !USEFUL.test(described)) return;
    const linkTokens = tokens(`${url.pathname} ${url.search}`);
    const tied = linkTokens.some((token) => pageTokens.has(token) || identity.has(token));
    if (!tied) return;
    seen.add(key);
    found.push({ url: url.toString(), text: label });
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === "a") {
          href = attributes.href ?? null;
          text = attributes["aria-label"] ?? attributes.title ?? "";
          depth += 1;
        }
      },
      ontext(chunk) {
        if (depth > 0 && text.length < 200) text += chunk;
      },
      onclosetag(name) {
        if (name === "a" && depth > 0) {
          depth -= 1;
          if (href) consider(href, text);
          href = null;
          text = "";
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html.slice(0, 3 * 1024 * 1024));
  parser.end();
  return found;
}
