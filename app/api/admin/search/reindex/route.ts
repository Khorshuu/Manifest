import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { rebuildSearchIndex } from "@/lib/search/maintenance";
import { refuseNonStaff } from "@/lib/auth/api-guard";

/**
 * Rebuilds every product's index row. Never needed after an ordinary edit —
 * the database does that at commit — but useful after a change to how the
 * index is built, and harmless to press twice.
 */
export async function POST() {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  try {
    const result = await rebuildSearchIndex(await getCurrentUser());
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
