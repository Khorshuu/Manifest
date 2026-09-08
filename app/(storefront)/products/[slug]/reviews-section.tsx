import Link from "next/link";
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

function Stars({ rating }: { rating: number }) {
  return (
    <span className="text-meta text-brass">
      <span aria-hidden="true">{"★".repeat(rating)}</span>
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
    <section className="mt-14" id="reviews">
      <h2 className="font-display text-h2 text-ink">Reviews</h2>

      {count === 0 ? (
        <p className="mt-3 max-w-[70ch] text-body text-ink/70">
          No reviews yet. Only someone who has received this product can leave
          one, so the first will come after the first delivery.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-start gap-x-10 gap-y-4">
          <p className="text-body text-ink">
            <span className="font-display text-h2">{average}</span> out of 5 ·{" "}
            {count} review{count === 1 ? "" : "s"}
          </p>

          <ul className="min-w-0 flex-1">
            {([5, 4, 3, 2, 1] as const).map((value) => (
              <li key={value} className="flex items-center gap-3 py-0.5">
                <span className="w-12 text-meta text-ink/70">{value} star</span>
                <span
                  aria-hidden="true"
                  className="h-2 min-w-[2px] bg-blue-400"
                  style={{
                    width: `${count > 0 ? (breakdown[value] / count) * 100 : 0}%`,
                  }}
                />
                <span className="text-meta tabular-nums text-ink/70">
                  {breakdown[value]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {reviews.length > 0 ? (
        <ul className="mt-6 max-w-[70ch] border-t border-blue-300">
          {reviews.map((review) => (
            <li key={review.id} className="border-b border-blue-300 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <Stars rating={review.rating} />
                {review.title ? (
                  <p className="text-body font-medium text-ink">
                    {review.title}
                  </p>
                ) : null}
              </div>
              <p className="mt-1 text-meta text-ink/60">
                {review.authorName} · {formatShortDate(review.createdAt)} ·
                Verified purchase
              </p>
              {review.body ? (
                <p className="mt-2 whitespace-pre-wrap text-body text-ink/80">
                  {review.body}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-6">
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
              className="text-blue-600 underline"
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
