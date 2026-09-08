import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { submitReview } from "@/lib/reviews";
import { reviewInputSchema } from "@/lib/validation/reviews";

export async function POST(request: Request) {
  const parsed = reviewInputSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check what you entered." },
      { status: 400 },
    );
  }

  try {
    // Eligibility is decided in submitReview against delivered orders, not
    // from anything the browser sent.
    const user = await getCurrentUser();
    const review = await submitReview(user, parsed.data);

    return NextResponse.json(
      { review: { id: review.id, status: review.status } },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
