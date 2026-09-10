import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import {
  addToShowcase,
  moveInShowcase,
  removeFromShowcase,
  setShowcase,
  SHOWCASE_MAX,
} from "@/lib/homepage";

/**
 * The four products under the hero.
 *
 * Permission is enforced in the library functions rather than here, so the
 * same rule applies wherever they are called from — the homepage settings
 * page, and the button on a product's own admin page (CLAUDE.md §7).
 */

const bodySchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set"),
      slugs: z.array(z.string().min(1).max(160)).max(SHOWCASE_MAX),
    })
    .strict(),
  z.object({ action: z.literal("add"), slug: z.string().min(1).max(160) }).strict(),
  z.object({ action: z.literal("remove"), slug: z.string().min(1).max(160) }).strict(),
  z
    .object({
      action: z.literal("move"),
      slug: z.string().min(1).max(160),
      direction: z.enum(["up", "down"]),
    })
    .strict(),
]);

export async function PATCH(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();
    const body = parsed.data;

    const showcase =
      body.action === "set"
        ? await setShowcase(user, body.slugs)
        : body.action === "add"
          ? await addToShowcase(user, body.slug)
          : body.action === "remove"
            ? await removeFromShowcase(user, body.slug)
            : await moveInShowcase(user, body.slug, body.direction);

    return NextResponse.json({ showcase });
  } catch (error) {
    return toErrorResponse(error);
  }
}
