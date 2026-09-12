import Link from "next/link";

const LINKS = [
  { href: "/account", label: "Dashboard" },
  { href: "/account/orders", label: "Orders" },
  { href: "/account/wishlist", label: "Wishlist" },
  { href: "/account/addresses", label: "Addresses" },
  { href: "/account/security", label: "Security" },
] as const;

/**
 * The account's sections, one row of the same chips the admin order filters
 * use. Scrolls sideways on a narrow phone rather than wrapping into a block.
 */
export function AccountNav({ current }: { current: (typeof LINKS)[number]["href"] }) {
  return (
    <nav aria-label="Your account" className="-mx-4 mt-6 overflow-x-auto px-4">
      <ul className="flex gap-2">
        {LINKS.map((link) => (
          <li key={link.href} className="shrink-0">
            <Link
              href={link.href}
              aria-current={current === link.href ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-control border px-3 text-meta transition-colors ${
                current === link.href
                  ? "border-blue-600 bg-blue-50 font-medium text-blue-600"
                  : "border-blue-300 text-ink hover:border-blue-500 hover:bg-blue-50"
              }`}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
