import Link from "next/link";
import { stepIndex, wizardHref, WIZARD_STEPS, type WizardStep } from "./steps";

/**
 * Every step stays reachable. A wizard that locks steps behind each other
 * punishes the common case — someone coming back to fix one field — so the
 * sequence is guidance, and the publish gate is the only real barrier.
 */
export function Stepper({
  productId,
  current,
}: {
  productId: string;
  current: WizardStep;
}) {
  const currentIndex = stepIndex(current);

  return (
    <nav aria-label="Product setup steps">
      <ol className="flex min-w-0 flex-wrap gap-x-1 gap-y-2">
        {WIZARD_STEPS.map((step, index) => {
          const isCurrent = step.id === current;
          const isDone = index < currentIndex;

          return (
            <li key={step.id} className="flex items-center gap-1">
              <Link
                href={wizardHref(productId, step.id)}
                aria-current={isCurrent ? "step" : undefined}
                className={`inline-flex min-h-11 items-center gap-2 rounded-control border px-3 text-meta ${
                  isCurrent
                    ? "border-blue-600 text-blue-600"
                    : isDone
                      ? "border-blue-300 text-ink"
                      : "border-blue-200 text-ink/60"
                }`}
              >
                <span className="tabular-nums">{index + 1}</span>
                {step.label}
              </Link>
              {index < WIZARD_STEPS.length - 1 ? (
                <span aria-hidden="true" className="text-blue-300">
                  —
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
