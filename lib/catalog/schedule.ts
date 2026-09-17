import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, products, users } from "@/db/schema";
import { can } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { inferLiveStatus, unpublishProduct } from "./product-lifecycle";
import { PUBLIC_STATUSES } from "./products";
import { NotReadyError, publishProduct } from "./readiness";

/**
 * Acting on a listing's publish and unpublish dates (D-056).
 *
 * Staff set "Publish on" and "Unpublish on" in the editor. Until this existed
 * nothing read them: a listing scheduled for Friday simply stayed a draft.
 *
 * A due listing goes through `publishProduct`, the same check a person runs,
 * so a date can never put an unfinished listing live; one that fails keeps its
 * date and is reported, and is tried again on the next run. The change is made
 * on behalf of the staff member who last edited the listing — the audit log
 * needs a person, and that is the person who set the date — and only if they
 * still have catalogue access.
 *
 * Each date is claimed by clearing it before acting, in one guarded update, so
 * two overlapping runs never act on the same listing twice. A publish that is
 * refused puts the date back.
 */

export type ScheduleReport = {
  published: string[];
  unpublished: string[];
  notReady: { productId: string; failures: string[] }[];
  skipped: { productId: string; reason: string }[];
};

async function actingStaff(productId: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email, role: users.role, firstName: users.firstName })
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(eq(auditLog.entityType, "product"), eq(auditLog.entityId, productId)))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1);
  if (!row) return null;
  const user = row as SessionUser;
  return can(user, "catalog.manage") ? user : null;
}

export async function applyPublishSchedule(now: Date = new Date(), limit = 100): Promise<ScheduleReport> {
  const report: ScheduleReport = { published: [], unpublished: [], notReady: [], skipped: [] };

  const duePublish = await db
    .select({ id: products.id, publishAt: products.publishAt })
    .from(products)
    .where(
      and(
        inArray(products.status, ["draft", "scheduled"]),
        isNull(products.archivedAt),
        lte(products.publishAt, now),
      ),
    )
    .limit(limit);

  for (const { id, publishAt } of duePublish) {
    const staff = await actingStaff(id);
    if (!staff) {
      report.skipped.push({ productId: id, reason: "nobody with catalogue access has edited it" });
      continue;
    }

    const [claimed] = await db
      .update(products)
      .set({ publishAt: null })
      .where(and(eq(products.id, id), lte(products.publishAt, now)))
      .returning({ id: products.id });
    if (!claimed) continue;

    try {
      await publishProduct(staff, id, await inferLiveStatus(id));
      report.published.push(id);
    } catch (error) {
      // Refused: the date goes back, so it is tried again once the listing is finished.
      await db
        .update(products)
        .set({ publishAt })
        .where(and(eq(products.id, id), isNull(products.publishAt)));
      if (error instanceof NotReadyError) {
        report.notReady.push({ productId: id, failures: error.failures });
      } else {
        report.skipped.push({ productId: id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const dueUnpublish = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        inArray(products.status, [...PUBLIC_STATUSES]),
        isNull(products.archivedAt),
        lte(products.unpublishAt, now),
      ),
    )
    .limit(limit);

  for (const { id } of dueUnpublish) {
    const staff = await actingStaff(id);
    if (!staff) {
      report.skipped.push({ productId: id, reason: "nobody with catalogue access has edited it" });
      continue;
    }

    const [claimed] = await db
      .update(products)
      .set({ unpublishAt: null })
      .where(and(eq(products.id, id), lte(products.unpublishAt, now)))
      .returning({ id: products.id });
    if (!claimed) continue;

    await unpublishProduct(staff, id);
    report.unpublished.push(id);
  }

  return report;
}
