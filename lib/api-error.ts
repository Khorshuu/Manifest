import { NextResponse } from "next/server";

/**
 * Turns a thrown domain error into a response. Errors that carry a `status`
 * are ours and safe to show; anything else is logged and reported as a
 * generic failure, so an internal message never reaches a client.
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const known = error as { status: number; message: string };
    return NextResponse.json({ error: known.message }, { status: known.status });
  }

  console.error(error);
  return NextResponse.json(
    { error: "Something went wrong. Try again." },
    { status: 500 },
  );
}
