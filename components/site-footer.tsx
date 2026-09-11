import Link from "next/link";
import {
  IconArrowRight,
  IconPlane,
  IconSeal,
  IconTruck,
  IconUser,
} from "./icons";
import { NewsletterForm } from "./newsletter-form";

/**
 * The footer, laid out as the foot of a form: the promise on the left, the
 * things a worried shopper looks for on the right.
 *
 * Every link here goes somewhere that exists. A footer full of dead links to
 * pages nobody has written is worse than a short one.
 */

const HELP = [
  { href: "/orders/lookup", label: "Track an order", icon: IconTruck },
  { href: "/search?available=1", label: "What can be bought now", icon: IconPlane },
  { href: "/account", label: "Your account", icon: IconUser },
  { href: "/help", label: "Help, shipping and refunds", icon: IconSeal },
];

const HOW = [
  "Nothing is bought until the window closes.",
  "Cancel for a full refund until we buy it.",
  "Duty is paid by us, in advance.",
];

export function SiteFooter() {
  return (
    <footer className="surface-paper mt-16 border-t border-ink/15">
      <div className="mx-auto grid w-full max-w-[1280px] gap-10 px-4 py-14 md:grid-cols-[1.5fr_1fr_1fr] md:px-6">
        <div>
          <p className="flex items-baseline gap-2 font-display text-h2 tracking-tight text-ink">
            Manifest
          </p>
          <p className="mt-4 max-w-[46ch] text-meta text-ink/70">
            American products sourced to order and delivered in Bangladesh.
            Every price includes shipping and customs duty, so the amount you
            see is the amount you pay.
          </p>

          <Link
            href="/search?available=1"
            className="mt-6 inline-flex items-center gap-2 text-meta font-medium text-blue-600 underline-offset-4 hover:underline"
          >
            See every open window
            <IconArrowRight size={16} />
          </Link>

          <NewsletterForm />
        </div>

        <div>
          <h2 className="text-meta font-medium uppercase tracking-[0.14em] text-ink">
            Help
          </h2>
          <ul className="mt-4 flex flex-col gap-1">
            {HELP.map(({ href, label, icon: Glyph }) => (
              <li key={href}>
                <Link
                  href={href}
                  className="group inline-flex min-h-9 items-center gap-2.5 text-meta text-ink/70 transition-colors hover:text-ink"
                >
                  <Glyph
                    size={17}
                    className="shrink-0 text-blue-400 transition-colors group-hover:text-blue-600"
                  />
                  <span className="link-draw">{label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2 className="text-meta font-medium uppercase tracking-[0.14em] text-ink">
            How preordering works
          </h2>
          <ul className="mt-4 flex flex-col gap-2.5">
            {HOW.map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-meta text-ink/70">
                <IconSeal size={16} className="mt-0.5 shrink-0 text-blue-400" />
                {line}
              </li>
            ))}
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
