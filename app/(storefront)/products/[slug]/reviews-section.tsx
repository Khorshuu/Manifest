import Link from "next/link";
import { IconStar } from "@/components/icons";
import { Panel } from "@/components/panel";
import { formatShortDate } from "@/lib/format";
import type { PublicReview } from "@/lib/reviews";
import { ReviewForm } from "./review-form";

type Props = {
  productId: string;
  productSlug: string;
  reviews: PublicReview[];
  average: number | null;
  count: number;
  breakdown: Record<1 | 2 | 3 | 4 | 5, number>;
  /** Decided on the server from delivered orders. */
  canReview: boolean;
  isSignedIn: boolean;
  alreadyReviewed: boolean;
};

/**
 * Five drawn stars with the earned ones filled, rather than a run of ★
 * characters — the glyph renders at a different weight in every font and was
 * the one place on the site an icon came from the typeface.
 */
function Stars({ rating, size = 16 }: { rating: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-brass">
      {[1, 2, 3, 4, 5].map((value) => (
        <IconStar
          key={value}
          size={size}
          className={value <= rating ? "fill-brass" : "text-blue-300"}
        />
      ))}
      <span className="sr-only">{rating} out of 5</span>
    </span>
  );
}

export function ReviewsSection({
  productId,
  productSlug,
  reviews,
  average,
  count,
  breakdown,
  canReview,
  isSignedIn,
  alreadyReviewed,
}: Props) {
  return (
    <section className="mt-16 border-t border-ink/15 pt-10" id="reviews">
      <p className="flex items-center gap-3 text-meta uppercase tracking-[0.18em] text-brass-text">
        <span aria-hidden="true" className="h-px w-8 bg-brass" />
        From people who received it
      </p>
      <h2 className="mt-2 font-display text-h1 text-ink">Reviews</h2>

      {count === 0 ? (
        /*
         * A young catalogue has no reviews on most listings, so this is the
         * state most shoppers actually see. Saying *why* it is empty turns an
         * absence into a guarantee: nothing here was written by anyone who did
         * not receive the thing.
         */
        <Panel tone="raised" className="mt-6 max-w-[70ch] p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <span
              aria-hidden="true"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-card border border-blue-300 bg-paper text-blue-500"
            >
              <IconStar size={22} />
            </span>
            <div>
              <p className="font-display text-h3 text-ink">No reviews yet</p>
              <p className="mt-1.5 text-meta text-ink/70">
                Only someone whose order was delivered can leave one, so the
                first will come after the first delivery. Nothing here is
                written by anyone who has not had the product in their hands.
              </p>
            </div>
          </div>
        </Panel>
      ) : (
        <Panel tone="raised" className="mt-6 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-x-10 gap-y-5">
            <div className="shrink-0">
              <p className="font-display text-[2.5rem] leading-none tabular-nums text-ink">
                {average}
              </p>
              <div className="mt-2">
                <Stars rating={Math.round(average ?? 0)} size={18} />
              </div>
              <p className="mt-1.5 text-meta text-ink/70">
                {count} review{count === 1 ? "" : "s"}
              </p>
            </div>

            <ul className="min-w-[220px] flex-1">
              {([5, 4, 3, 2, 1] as const).map((value) => {
                const share = count > 0 ? (breakdown[value] / count) * 100 : 0;

                return (
                  <li key={value} className="flex items-center gap-3 py-0.5">
                    <span className="w-12 shrink-0 text-meta text-ink/70">
                      {value} star
                    </span>
                    <span
                      aria-hidden="true"
                      className="h-2 min-w-0 flex-1 overflow-hidden rounded-card bg-blue-200"
                    >
                      <span
                        className="block h-full rounded-card bg-brass"
                        style={{ width: `${share}%` }}
                      />
                    </span>
                    <span className="w-6 shrink-0 text-right text-meta tabular-nums text-ink/70">
                      {breakdown[value]}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </Panel>
      )}

      {reviews.length > 0 ? (
        <ul className="mt-6 grid max-w-[74rem] gap-4 md:grid-cols-2">
          {reviews.map((review) => (
            <li
              key={review.id}
              className="flex flex-col gap-2 rounded-card border border-blue-300 bg-paper p-5 shadow-[var(--shadow-raise)]"
            >
              <div className="flex flex-wrap items-center gap-3">
                <Stars rating={review.rating} />
                {review.title ? (
                  <p className="text-body font-medium text-ink">
                    {review.title}
                  </p>
                ) : null}
              </div>

              <p className="flex flex-wrap items-center gap-x-2 text-meta text-ink/70">
                <span>{review.authorName}</span>
                <span aria-hidden="true">·</span>
                <span>{formatShortDate(review.createdAt)}</span>
                <span aria-hidden="true">·</span>
                <span className="text-transit-green-text">
                  Verified purchase
                </span>
              </p>

              {review.body ? (
                <p className="whitespace-pre-wrap text-body text-ink/80">
                  {review.body}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-8">
        {canReview ? (
          <ReviewForm productId={productId} />
        ) : alreadyReviewed ? (
          <p className="text-meta text-ink/70">
            You have already reviewed this product.
          </p>
        ) : isSignedIn ? (
          <p className="max-w-[70ch] text-meta text-ink/70">
            Reviews come from delivered orders only. Once this reaches you, the
            form appears here.
          </p>
        ) : (
          <p className="max-w-[70ch] text-meta text-ink/70">
            <Link
              href={`/login?next=/products/${productSlug}`}
              className="text-blue-600 underline underline-offset-4"
            >
              Sign in
            </Link>{" "}
            to review a product you have received.
          </p>
        )}
      </div>
    </section>
  );
}
