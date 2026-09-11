import { NextResponse } from "next/server";
import { z } from "zod";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { removeAddress, setDefaultAddress, updateAddress } from "@/lib/account";
import { accountAddressSchema } from "@/lib/validation/account";

const makeDefaultOnly = z.object({ makeDefault: z.literal(true) }).strict();

async function addressIdFrom(
  context: RouteContext<"/api/account/addresses/[addressId]">,
) {
  const { addressId } = await context.params;
  return z.string().uuid().safeParse(addressId).success ? addressId : null;
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/account/addresses/[addressId]">,
) {
  const addressId = await addressIdFrom(context);
  if (!addressId) {
    return NextResponse.json({ error: "That address was not found." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);

  try {
    const user = await getCurrentUser();

    if (makeDefaultOnly.safeParse(body).success) {
      await setDefaultAddress(user, addressId);
      return NextResponse.json({ address: { id: addressId } });
    }

    const parsed = accountAddressSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Check the address." },
        { status: 400 },
      );
    }

    const address = await updateAddress(user, addressId, parsed.data);
    return NextResponse.json({ address: { id: address.id } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/account/addresses/[addressId]">,
) {
  const addressId = await addressIdFrom(context);
  if (!addressId) {
    return NextResponse.json({ error: "That address was not found." }, { status: 400 });
  }

  try {
    await removeAddress(await getCurrentUser(), addressId);
    return NextResponse.json({ removed: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
