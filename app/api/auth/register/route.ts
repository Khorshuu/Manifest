import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { EmailTakenError, register } from "@/lib/auth/accounts";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/session";
import { registerSchema } from "@/lib/validation/auth";

export async function POST(request: Request) {
  const parsed = registerSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the details you entered." },
      { status: 400 },
    );
  }

  try {
    const { session, user } = await register(parsed.data);
    const store = await cookies();
    store.set(SESSION_COOKIE_NAME, session.token, {
      ...sessionCookieOptions,
      expires: session.expiresAt,
    });
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    if (error instanceof EmailTakenError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
