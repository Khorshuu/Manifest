import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { CAMPAIGN_SLOTS, moveCampaign, updateCampaign } from "@/lib/homepage";

/**
 * The homepage campaigns, managed by staff with `homepage.manage`.
 *
 * Permission is enforced in the library functions rather than here, so any
 * other caller is gated the same way (CLAUDE.md §7). The patch itself is
 * validated there too, against the same schema the stored record uses.
 */
const bodySchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("update"),
      slot: z.number().int().min(0).max(CAMPAIGN_SLOTS - 1),
      patch: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      action: z.literal("move"),
      slot: z.number().int().min(0).max(CAMPAIGN_SLOTS - 1),
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
    const campaigns =
      body.action === "update"
        ? await updateCampaign(user, body.slot, body.patch)
        : await moveCampaign(user, body.slot, body.direction);

    return NextResponse.json({ campaigns });
  } catch (error) {
    return toErrorResponse(error);
  }
}
