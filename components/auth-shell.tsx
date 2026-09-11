import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowLeft, IconSeal, IconShield, IconTag } from "./icons";

/** The reasons to have an account here, rather than generic marketing lines. */
const POINTS = [
  {
    icon: IconTag,
    text: "One landed price — shipping and Bangladeshi customs duty are already inside it.",
  },
  {
    icon: IconSeal,
    text: "Nothing is bought until the batch closes, so nothing is charged for a shipment that did not happen.",
  },
  {
    icon: IconShield,
    text: "Every order keeps its whole journey, from the window closing to the courier at your door.",
  },
];

/**
 * The frame around sign-in and sign-up.
 *
 * Both sit outside the storefront layout, so this panel is the identity the
 * header would normally carry; it stacks away on a phone so the form is still
 * the first thing on the screen. The tabs at the top make the two ways in —
 * signing in and creating an account — equally easy to find.
 */
export function AuthShell({
  mode,
  title,
  summary,
  next,
  children,
  footer,
}: {
  mode: "signin" | "signup";
  title: string;
  summary: string;
  /** Carried between the two tabs so either one returns to the same place. */
  next: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const query = next !== "/" ? `?next=${encodeURIComponent(next)}` : "";

  const tab = (active: boolean) =>
    `flex min-h-10 flex-1 items-center justify-center rounded-control text-meta font-semibold transition-colors ${
      active
        ? "bg-paper text-ink shadow-[var(--shadow-raise)]"
        : "text-ink/65 hover:text-ink"
    }`;

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="surface-ink relative order-2 hidden overflow-hidden p-10 text-paper lg:order-1 lg:flex lg:flex-col lg:justify-between xl:p-14">
        <div
          aria-hidden="true"
          className="grid-rule pointer-events-none absolute inset-0 text-paper opacity-[0.07]"
        />

        <Link
          href="/"
          className="relative flex items-baseline gap-2 font-display tracking-tight"
        >
          <span className="text-h2">Manifest</span>
        </Link>

        <div className="relative max-w-[38ch]">
          <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass">
            <span aria-hidden="true" className="h-px w-8 bg-brass" />
            New York to Dhaka
          </p>
          <h2 className="mt-3 font-display text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.15] text-paper">
            American goods, landed in Bangladesh
          </h2>

          <ul className="mt-8 flex flex-col gap-5">
            {POINTS.map(({ icon: Glyph, text }) => (
              <li key={text} className="flex items-start gap-3">
                <Glyph size={20} className="mt-0.5 shrink-0 text-brass" />
                <p className="text-meta text-paper/75">{text}</p>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-meta text-paper/50">
          Prices in Bangladeshi taka. Duty and freight are paid by us, in
          advance.
        </p>
      </section>

      <section className="order-1 flex flex-col justify-center px-6 py-10 lg:order-2 lg:px-14 xl:px-20">
        <div className="mx-auto w-full max-w-md">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-meta text-blue-600 underline-offset-4 hover:underline lg:hidden"
          >
            <IconArrowLeft size={16} />
            Back to the shop
          </Link>

          <nav
            aria-label="Account"
            className="mt-6 flex gap-1 rounded-card bg-blue-50 p-1 lg:mt-0"
          >
            <Link
              href={`/login${query}`}
              aria-current={mode === "signin" ? "page" : undefined}
              className={tab(mode === "signin")}
            >
              Sign in
            </Link>
            <Link
              href={`/register${query}`}
              aria-current={mode === "signup" ? "page" : undefined}
              className={tab(mode === "signup")}
            >
              Create account
            </Link>
          </nav>

          <h1 className="mt-7 font-display text-h1 text-ink">{title}</h1>
          <p className="mt-2 text-body text-ink/70">{summary}</p>

          <div className="mt-7">{children}</div>

          {footer ? <div className="mt-7 text-meta text-ink/70">{footer}</div> : null}
        </div>
      </section>
    </main>
  );
}

/** Only same-site paths, so ?next= cannot be used as an open redirect. */
export function safeNext(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "/";
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}
