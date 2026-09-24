import Link from "next/link";

/**
 * The line an old intelligence address carries.
 *
 * These routes still work — a bookmark, a link in an older report and the
 * existing tests all use them — and they render exactly the component the
 * workspace renders. What they no longer have is the tab bar, so this says
 * where the same screen now lives rather than leaving somebody on a page the
 * navigation no longer points at.
 */
export function MovedNotice({ href, tab }: { href: string; tab: string }) {
  return (
    <p className="admin-card p-3 text-[0.8125rem] text-ink/70">
      This screen is now the <strong className="font-medium text-ink">{tab}</strong> tab of{" "}
      <Link href={href} className="text-blue-600 hover:underline">
        Intelligence
      </Link>
      . This address still works.
    </p>
  );
}
