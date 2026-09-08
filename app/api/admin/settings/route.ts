import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { updateSetting } from "@/lib/admin";
import { getCurrentUser } from "@/lib/auth";

const bodySchema = z
  .object({
    key: z.string().min(1).max(120),
    // Validated properly against the setting's own schema in updateSetting;
    // this only gets it past JSON parsing.
    value: z.union([z.string(), z.number(), z.boolean()]),
  })
  .strict();

/** Super admin only, enforced in updateSetting rather than here. */
export async function PATCH(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();
    const setting = await updateSetting(user, parsed.data.key, parsed.data.value);
    return NextResponse.json({ setting });
  } catch (error) {
    return toErrorResponse(error);
  }
}
