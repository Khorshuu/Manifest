import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import {
  CAMPAIGN_SLOTS,
  SHOWCASE_SLOTS,
  clearCampaignImage,
  setCampaignImage,
  type ImageTarget,
} from "@/lib/homepage";
import { MAX_UPLOAD_BYTES } from "@/lib/providers/media";

/**
 * Hero and showcase-tile images for one campaign slide.
 *
 * Uploads only: the image arrives as bytes and is stored by the media
 * provider, so a campaign can never be pointed at an address off this site.
 * Permission is checked inside `lib/homepage`.
 */
const targetSchema = z.object({
  slot: z.coerce.number().int().min(0).max(CAMPAIGN_SLOTS - 1),
  target: z.enum(["hero", "tile"]),
  tile: z.coerce.number().int().min(0).max(SHOWCASE_SLOTS - 1).optional(),
});

function toTarget(input: z.infer<typeof targetSchema>): ImageTarget | null {
  if (input.target === "hero") return { kind: "hero" };
  return input.tile === undefined ? null : { kind: "tile", tile: input.tile };
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_UPLOAD_BYTES * 2) {
      return NextResponse.json({ error: "That file is too large." }, { status: 413 });
    }

    const form = await request.formData();
    const parsed = targetSchema.safeParse({
      slot: form.get("slot"),
      target: form.get("target"),
      tile: form.get("tile") ?? undefined,
    });
    const target = parsed.success ? toTarget(parsed.data) : null;
    const file = form.get("file");

    if (!parsed.success || !target) {
      return NextResponse.json({ error: "Check the request." }, { status: 400 });
    }
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "Choose an image." }, { status: 400 });
    }

    const campaigns = await setCampaignImage(user, parsed.data.slot, target, {
      data: Buffer.from(await file.arrayBuffer()),
      originalName: file.name,
      contentType: file.type,
    });

    return NextResponse.json({ campaigns }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const parsed = targetSchema.safeParse(await request.json().catch(() => null));
  const target = parsed.success ? toTarget(parsed.data) : null;

  if (!parsed.success || !target) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();
    const campaigns = await clearCampaignImage(user, parsed.data.slot, target);
    return NextResponse.json({ campaigns });
  } catch (error) {
    return toErrorResponse(error);
  }
}
