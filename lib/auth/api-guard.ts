import { NextResponse } from "next/server";
import { isStaff } from "./authorize";
import { getCurrentUser } from "./current-user";

/**
 * The first line of every admin API handler (PRODUCTION-READINESS 18.1).
 *
 * Refuses anyone who is not staff before the request is read: a signed-out
 * visitor gets 401 and a customer 403, whatever they sent. Handlers used to
 * validate the body first, so a customer probing an admin endpoint was told
 * which fields it expected, and a body the handler could not parse was a 500.
 *
 * It is the boundary between customers and staff, not the permission check:
 * each `lib/` function still requires its own permission, so an operations
 * manager is refused finance even though they pass this.
 */
export async function refuseNonStaff(): Promise<NextResponse | null> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "You need to sign in to do that." }, { status: 401 });
  }
  if (!isStaff(user)) {
    return NextResponse.json({ error: "Only staff and administrators can do that." }, { status: 403 });
  }
  return null;
}
