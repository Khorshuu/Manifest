import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { createAddress } from "@/lib/account";
import { accountAddressSchema } from "@/lib/validation/account";

export async function POST(request: Request) {
  const parsed = accountAddressSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the address." },
      { status: 400 },
    );
  }

  try {
    const address = await createAddress(await getCurrentUser(), parsed.data);
    return NextResponse.json({ address: { id: address.id } }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
