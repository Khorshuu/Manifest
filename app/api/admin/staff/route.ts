import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, STAFF_ROLES } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { changeRole, createStaffAccount } from "@/lib/admin";
import { STAFF_PASSWORD_MIN } from "@/lib/admin/staff";

const createSchema = z
  .object({
    email: z.string().trim().toLowerCase().email("Enter a valid email address."),
    password: z
      .string()
      .min(STAFF_PASSWORD_MIN, `Use at least ${STAFF_PASSWORD_MIN} characters.`)
      .max(200),
    firstName: z.string().trim().max(60).optional(),
    role: z.enum(STAFF_ROLES),
  })
  .strict();

/**
 * A role is changed to another staff role, or "customer" to take staff
 * access away. Either way it goes through `changeRole`, which is owner-only.
 */
const roleSchema = z
  .object({
    userId: z.string().uuid(),
    role: z.enum([...STAFF_ROLES, "customer"]),
  })
  .strict();

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the details." },
      { status: 400 },
    );
  }

  try {
    const user = await getCurrentUser();
    return NextResponse.json({
      account: await createStaffAccount(user, parsed.data),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const parsed = roleSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Check the request." }, { status: 400 });
  }

  try {
    const user = await getCurrentUser();
    return NextResponse.json({
      account: await changeRole(user, parsed.data.userId, parsed.data.role),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
