import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { decideRegistryEntry, suggestRegistryEntry } from "@/lib/pkb/trust";

/**
 * The Brand Source Registry. A brand existing in the catalogue says nothing
 * about which of its domains are trusted: every entry starts as a suggestion
 * and becomes authority only when someone approves it (A-9, D-071).
 */
const ROLES = [
  "official_product",
  "official_support",
  "official_documentation",
  "manufacturer_feed",
  "authorized_distributor",
  "trusted_retailer",
  "product_database",
  "supplier_feed",
  "approved_secondary",
  "blocked",
] as const;

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("suggest"),
    brandId: z.string().uuid().nullish(),
    role: z.enum(ROLES),
    domain: z.string().max(253).nullish(),
    pathPrefix: z.string().max(200).nullish(),
    providerKey: z.string().max(80).nullish(),
    urlTemplate: z.string().max(500).nullish(),
    preference: z.number().int().min(0).max(999).optional(),
    note: z.string().max(500).nullish(),
  }),
  z.object({
    action: z.literal("decide"),
    entryId: z.string().uuid(),
    decision: z.enum(["approved", "rejected", "retired"]),
  }),
]);

export async function POST(request: Request) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the request." }, { status: 400 });
  }

  try {
    const actor = await getCurrentUser();
    const input = parsed.data;
    if (input.action === "decide") {
      return NextResponse.json(await decideRegistryEntry(actor, input.entryId, input.decision));
    }
    return NextResponse.json(
      await suggestRegistryEntry(actor, {
        brandId: input.brandId ?? null,
        role: input.role,
        domain: input.domain ?? null,
        pathPrefix: input.pathPrefix ?? null,
        providerKey: input.providerKey ?? null,
        urlTemplate: input.urlTemplate ?? null,
        preference: input.preference,
        note: input.note ?? null,
      }),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
