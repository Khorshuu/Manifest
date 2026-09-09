import Link from "next/link";

/**
 * The footer, laid out as the foot of a form: the promise on the left, the
 * things a worried shopper looks for on the right.
 *
 * Every link here goes somewhere that exists. A footer full of dead links to
 * pages nobody has written is worse than a short one.
 */

const HELP = [
  { href: "/orders/lookup", label: "Track an order" },
  { href: "/search?available=1", label: "What can be bought now" },
  { href: "/account", label: "Your account" },
];

export function SiteFooter() {
  return (
    <footer className="surface-paper mt-16 border-t border-ink/15">
      <div className="mx-auto grid w-full max-w-[1280px] gap-10 px-4 py-12 md:grid-cols-[1.5fr_1fr_1fr] md:px-6">
        <div>
          <p className="font-display text-h3 text-ink">Manifest</p>
          <p className="mt-3 max-w-[46ch] text-meta text-ink/70">
            American products sourced to order and delivered in Bangladesh.
            Every price includes shipping and customs duty, so the amount you
            see is the amount you pay.
          </p>
        </div>

        <div>
          <h2 className="text-meta font-medium text-ink">Help</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {HELP.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="text-meta text-ink/70 hover:text-ink hover:underline"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2 className="text-meta font-medium text-ink">How preordering works</h2>
          <ul className="mt-3 flex flex-col gap-2 text-meta text-ink/70">
            <li>Nothing is bought until the window closes.</li>
            <li>Cancel for a full refund until we buy it.</li>
            <li>Duty is paid by us, in advance.</li>
          </ul>
        </div>
      </div>

      <div className="border-t border-ink/10">
        <p className="mx-auto w-full max-w-[1280px] px-4 py-5 text-meta text-ink/70 md:px-6">
          Prices in Bangladeshi taka. Arrival windows are estimates — customs
          clearance is the part nobody can promise to the day.
        </p>
      </div>
    </footer>
  );
}
