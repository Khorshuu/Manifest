import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import {
  clearHeroImage,
  replaceHeroImage,
  updateHeroSettings,
} from "@/lib/homepage";
import { MAX_UPLOAD_BYTES } from "@/lib/providers/media";

/**
 * The homepage hero, managed by staff.
 *
 * Permission is enforced in the library functions rather than here, so calling
 * them from anywhere else is gated the same way — hiding the admin page would
 * not be access control (CLAUDE.md §7).
 */

/** A new photograph. Multipart, so the browser streams the file. */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_UPLOAD_BYTES * 2) {
      return NextResponse.json(
        { error: "That file is too large." },
        { status: 413 },
      );
    }

    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose a file." }, { status: 400 });
    }

    const hero = await replaceHeroImage(user, {
      data: Buffer.from(await file.arrayBuffer()),
      originalName: file.name,
      contentType: file.type,
    });

    return NextResponse.json({ hero }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * The words, the focal point and the header contrast mode. Every field is
 * optional: the admin page saves one section at a time, so a rejected headline
 * cannot discard an unrelated edit.
 */
const patchSchema = z
  .object({
    focalX: z.number().min(0).max(100).optional(),
    focalY: z.number().min(0).max(100).optional(),
    contrast: z.enum(["auto", "light", "dark"]).optional(),
    eyebrow: z.string().max(80).optional(),
    headline: z.string().min(1).max(120).optional(),
    support: z.string().max(280).optional(),
    ctaLabel: z.string().min(1).max(40).optional(),
    ctaHref: z.string().max(200).optional(),
    featuredSlug: z.string().max(160).nullable().optional(),
  })
  .strict();

export async function PATCH(request: Request) {
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the request." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();
    const hero = await updateHeroSettings(user, parsed.data);
    return NextResponse.json({ hero });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Removes the photograph. The hero falls back to catalogue artwork. */
export async function DELETE() {
  try {
    const user = await getCurrentUser();
    const hero = await clearHeroImage(user);
    return NextResponse.json({ hero });
  } catch (error) {
    return toErrorResponse(error);
  }
}
