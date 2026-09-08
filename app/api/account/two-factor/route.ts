import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import {
  beginEnrollment,
  confirmEnrollment,
  disableTwoFactor,
  getTwoFactorStatus,
} from "@/lib/auth/two-factor";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin") }).strict(),
  z
    .object({ action: z.literal("confirm"), code: z.string().trim().min(1).max(16) })
    .strict(),
  z
    .object({ action: z.literal("disable"), code: z.string().trim().min(1).max(64) })
    .strict(),
]);

export async function GET() {
  try {
    const user = await getCurrentUser();
    return NextResponse.json(await getTwoFactorStatus(user));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Enrolment, confirmation and removal, all for the signed-in account only.
 * Nothing here takes a user id: a request can only ever change the account it
 * is already authenticated as.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    }

    if (parsed.data.action === "begin") {
      // The secret is returned once, to be scanned. It is stored unconfirmed,
      // so nothing changes about signing in until a code proves it works.
      return NextResponse.json({ enrollment: await beginEnrollment(user) });
    }

    if (parsed.data.action === "confirm") {
      const { recoveryCodes } = await confirmEnrollment(user, parsed.data.code);
      // Shown once. They are stored hashed and cannot be read back.
      return NextResponse.json({ recoveryCodes });
    }

    await disableTwoFactor(user, parsed.data.code);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
