import Link from "next/link";
import { IconCheck } from "./icons";

/**
 * Where you are in buying something.
 *
 * `multi-step-progress` in the UX data: a multi-step flow shows a step
 * indicator and allows going back. Checkout had neither — you left the cart
 * and arrived at a long form with no sense of how much of it there was, which
 * is the point in an unfamiliar shop where people give up.
 *
 * Drawn in the site's own language rather than as generic numbered circles:
 * square checkpoints on a dotted rule, the same shape the order tracker uses
 * once the order exists, so the journey looks continuous from cart to
 * delivery.
 */

const STEPS = [
  { id: "cart", label: "Cart", href: "/cart" },
  { id: "details", label: "Details", href: null },
  { id: "done", label: "Confirmation", href: null },
] as const;

export type CheckoutStep = (typeof STEPS)[number]["id"];

export function CheckoutSteps({ current }: { current: CheckoutStep }) {
  const currentIndex = STEPS.findIndex((step) => step.id === current);

  return (
    <nav aria-label="Checkout progress" className="mt-6">
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:gap-x-4">
        {STEPS.map((step, index) => {
          const passed = index < currentIndex;
          const active = index === currentIndex;
          // Only a completed step you can actually return to is a link.
          const backTo = passed && step.href ? step.href : null;

          const marker = (
            <>
              <span
                aria-hidden="true"
                className={`inline-flex size-5 shrink-0 items-center justify-center rounded-card border ${
                  passed
                    ? "border-transit-green bg-transit-green text-paper"
                    : active
                      ? "border-brass bg-brass text-ink"
                      : "border-blue-400 text-transparent"
                }`}
              >
                {passed ? <IconCheck size={12} /> : null}
              </span>
              <span
                className={`text-meta ${
                  active ? "font-medium text-ink" : "text-ink/70"
                }`}
              >
                {step.label}
              </span>
            </>
          );

          return (
            <li key={step.id} className="flex items-center gap-3 sm:gap-4">
              {backTo ? (
                <Link
                  href={backTo}
                  className="flex items-center gap-2 rounded-control underline-offset-4 hover:underline"
                >
                  {marker}
                </Link>
              ) : (
                <span
                  className="flex items-center gap-2"
                  aria-current={active ? "step" : undefined}
                >
                  {marker}
                </span>
              )}

              {index < STEPS.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={`hidden h-px w-8 sm:block ${
                    passed ? "bg-transit-green" : "border-t border-dotted border-blue-400"
                  }`}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
