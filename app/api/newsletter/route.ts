import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { subscribeToNewsletter } from "@/lib/account";
import { consumeRateLimit } from "@/lib/rate-limit";
import { newsletterSchema } from "@/lib/validation/account";

export async function POST(request: Request) {
  const parsed = newsletterSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Enter a valid email address." },
      { status: 400 },
    );
  }

  // A public form that writes rows: capped per address and per IP so it
  // cannot be used to fill the table.
  const headerList = await headers();
  const ip = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const limit = await consumeRateLimit(`newsletter:${ip}`, 20, 60 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many signups from here. Try again later." },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  try {
    const user = await getCurrentUser();
    await subscribeToNewsletter(parsed.data.email, { userId: user?.id ?? null });
    // The same answer whether or not the address was already on the list.
    return NextResponse.json({ subscribed: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
