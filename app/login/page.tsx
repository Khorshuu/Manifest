import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { IconArrowLeft, IconSeal, IconShield, IconTag } from "@/components/icons";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

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

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const params = await searchParams;
  const rawNext = typeof params.next === "string" ? params.next : "/";
  // Only same-site paths, so ?next= cannot be used as an open redirect.
  const redirectTo = rawNext.startsWith("/") && !rawNext.startsWith("//")
    ? rawNext
    : "/";

  const user = await getCurrentUser();
  if (user) redirect(redirectTo);

  return (
    /*
     * Sign-in sits outside the storefront layout, so it had no header, no
     * footer and no colour — a form floating in the middle of a blank page,
     * which is the least trustworthy thing a shop can show someone about to
     * type a password. The brand panel is the identity the header would
     * normally carry; it stacks away on a phone so the form is still the first
     * thing on the screen.
     */
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

      <section className="order-1 flex flex-col justify-center px-6 py-12 lg:order-2 lg:px-14 xl:px-20">
        <div className="mx-auto w-full max-w-md">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-meta text-blue-600 underline-offset-4 hover:underline lg:hidden"
          >
            <IconArrowLeft size={16} />
            Back to the shop
          </Link>

          <p className="mt-6 flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text lg:mt-0">
            <span aria-hidden="true" className="h-px w-8 bg-brass" />
            Account
          </p>
          <h1 className="mt-2 font-display text-h1 text-ink">Sign in</h1>
          <p className="mt-3 text-body text-ink/70">
            Track your preorders and manage your delivery addresses.
          </p>

          <div className="mt-9">
            <LoginForm redirectTo={redirectTo} />
          </div>

          <p className="mt-8 text-meta text-ink/70">
            Ordered without an account?{" "}
            <Link
              href="/orders/lookup"
              className="text-blue-600 underline-offset-4 hover:underline"
            >
              Track it with your order number
            </Link>
            .
          </p>
        </div>
      </section>
    </main>
  );
}
