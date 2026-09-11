import { redirect } from "next/navigation";
import { can, isStaff, type Permission } from "./authorize";
import { getCurrentUser } from "./current-user";
import type { SessionUser } from "./session";

/**
 * The first line of every admin page.
 *
 * The layout already turns away anyone who is not staff, but a layout cannot
 * see which page it wraps, so the section a role may not open is refused here.
 * This is for a tidy redirect; the `lib/` function the page calls checks the
 * same permission again and would refuse if this line were forgotten.
 */
export async function requireAdminPage(
  permission?: Permission,
): Promise<SessionUser> {
  const user = await getCurrentUser();

  if (!user) redirect("/login?next=/admin");
  if (!isStaff(user)) redirect("/");
  if (permission && !can(user, permission)) redirect("/admin?denied=1");

  return user;
}
