import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import { refuseNonStaff } from "@/lib/auth/api-guard";
import { requestSearchConsoleSync } from "@/lib/search-console";

/**
 * Asks for a Search Console sync. The work runs in a job; this returns the
 * sync row so the screen can show its state. Requesting the same window twice
 * inside a minute returns the first sync rather than starting a second
 * (D-096).
 *
 * The permission is checked inside `lib/`, not here.
 */
export async function POST() {
  const refused = await refuseNonStaff();
  if (refused) return refused;

  try {
    const result = await requestSearchConsoleSync(await getCurrentUser(), { trigger: "manual" });
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
