import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { decideAttributeProposal } from "@/lib/pkb/discovery";

/** Attribute discovery: Add to Family, Product only, or Ignore (D-073). */
const schema = z.object({
  proposalId: z.string().uuid(),
  action: z.enum(["add_to_family", "product_only", "ignore"]),
  definitionId: z.string().uuid().nullish(),
  label: z.string().min(1).max(200).optional(),
  note: z.string().max(500).nullish(),
  context: z.enum(["spec_table", "measurements", "variant_option", "source_document", "any"]).optional(),
  requirement: z.enum(["required", "recommended", "optional"]).optional(),
  searchable: z.boolean().optional(),
  filterable: z.boolean().optional(),
  seoRelevant: z.boolean().optional(),
  shape: z
    .object({
      dataType: z.enum(["text", "number", "quantity", "quantity_range", "boolean", "enum", "date", "url", "brand"]).optional(),
      cardinality: z.enum(["single", "multiple"]).optional(),
      unitDimension: z.string().max(40).nullish(),
      displayUnit: z.string().max(40).nullish(),
    })
    .optional(),
}).strict();

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/knowledge/products/[pkbProductId]/proposals">,
) {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  const { pkbProductId } = await context.params;
  if (!z.string().uuid().safeParse(pkbProductId).success) {
    return NextResponse.json({ error: "That product was not found." }, { status: 404 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the request." }, { status: 400 });
  }

  try {
    const { proposalId, ...decision } = parsed.data;
    return NextResponse.json(
      await decideAttributeProposal(await getCurrentUser(), proposalId, {
        ...decision,
        shape: decision.shape
          ? {
              ...decision.shape,
              unitDimension: decision.shape.unitDimension ?? null,
              displayUnit: decision.shape.displayUnit ?? null,
            }
          : undefined,
      }),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
