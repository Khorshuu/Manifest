import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { changeRole, createStaffAccount } from "@/lib/admin";

const createSchema = z
  .object({
    email: z.string().trim().toLowerCase().email("Enter a valid email address."),
    password: z.string().min(10, "Use at least 10 characters.").max(200),
    role: z.enum(["staff_admin", "super_admin"]),
  })
  .strict();

const roleSchema = z
  .object({
    userId: z.string().uuid(),
    role: z.enum(["super_admin", "staff_admin", "customer"]),
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
