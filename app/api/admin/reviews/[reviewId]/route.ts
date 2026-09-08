import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { moderateReview } from "@/lib/reviews";
import { moderationSchema } from "@/lib/validation/reviews";

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/reviews/[reviewId]">,
) {
  const { reviewId } = await context.params;

  if (!z.string().uuid().safeParse(reviewId).success) {
    return NextResponse.json(
      { error: "That review was not found." },
      { status: 400 },
    );
  }

  const parsed = moderationSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();
    const review = await moderateReview(user, reviewId, parsed.data.decision);
    return NextResponse.json({ review });
  } catch (error) {
    return toErrorResponse(error);
  }
}
