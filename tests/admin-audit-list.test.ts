/**
 * The audit log at scale: keyset paging over (created_at, id) visits every
 * entry exactly once even when many share one timestamp (every entry written
 * in one transaction does), goes back to exactly the previous page, keeps the
 * action filter, and lists distinct actions without grouping the whole log.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { listAuditActions, listAuditEntries, listAuditPage } from "@/lib/admin";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: SessionUser;
let expected: string[] = [];

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const [row] = await harness.db
    .insert(users)
    .values({ email: "owner@example.com", passwordHash: "x", role: "super_admin" })
    .returning({ id: users.id, email: users.email });
  owner = { id: row.id, email: row.email, role: "super_admin" };

  // Nine entries in one instant, three in microseconds of the same millisecond,
  // and two later ones.
  const shared = new Date("2026-09-01T12:00:00.000Z");
  await harness.db.insert(auditLog).values(
    Array.from({ length: 9 }, (_, index) => ({
      actorUserId: owner.id,
      action: index % 3 === 0 ? "product.updated" : "variant.updated",
      entityType: "product",
      entityId: `p-${index}`,
      createdAt: shared,
    })),
  );
  await harness.client.exec(`
    insert into audit_log (actor_user_id, action, entity_type, entity_id, created_at) values
      ('${owner.id}', 'category.updated', 'category', 'c-1', timestamptz '2026-09-02 08:00:00.100300+00'),
      ('${owner.id}', 'category.updated', 'category', 'c-2', timestamptz '2026-09-02 08:00:00.100200+00'),
      ('${owner.id}', 'order.status_changed', 'order', 'o-1', timestamptz '2026-09-02 08:00:00.100100+00'),
      ('${owner.id}', 'order.status_changed', 'order', 'o-2', timestamptz '2026-09-03 09:00:00+00'),
      ('${owner.id}', 'product.updated', 'product', 'p-late', timestamptz '2026-09-04 10:00:00+00');
  `);

  const all = (await harness.client.query<{ id: string }>(
    "select id from audit_log order by created_at desc, id desc",
  )).rows;
  expected = all.map((entry) => entry.id);
});

async function walk(limit: number, action?: string) {
  const seen: string[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 40; guard += 1) {
    const page = await listAuditPage(owner, { limit, after, action });
    seen.push(...page.entries.map((entry) => entry.id));
    if (!page.nextCursor) return seen;
    after = page.nextCursor;
  }
  throw new Error("paging did not end");
}

describe("audit log paging", () => {
  it("visits every entry exactly once, newest first, through shared timestamps", async () => {
    for (const limit of [1, 2, 4, 50]) {
      expect(await walk(limit), `${limit} per page`).toEqual(expected);
    }
  });

  it("goes back to exactly the previous page", async () => {
    const first = await listAuditPage(owner, { limit: 4 });
    expect(first.previousCursor).toBeNull();
    const second = await listAuditPage(owner, { limit: 4, after: first.nextCursor! });
    const back = await listAuditPage(owner, { limit: 4, before: second.previousCursor! });
    expect(back.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
    expect(back.previousCursor).toBeNull();
    expect(back.nextCursor).not.toBeNull();
  });

  it("keeps the action filter while paging", async () => {
    const filtered = await walk(2, "product.updated");
    const rows = await listAuditEntries(owner, { action: "product.updated", limit: 100 });
    expect(filtered).toEqual(rows.map((entry) => entry.id));
    expect(filtered).toHaveLength(4);
  });

  it("orders the offset list the same way", async () => {
    const rows = await listAuditEntries(owner, { limit: 100 });
    expect(rows.map((entry) => entry.id)).toEqual(expected);
  });

  it("lists each recorded action once, alphabetically", async () => {
    expect(await listAuditActions(owner)).toEqual([
      "category.updated",
      "order.status_changed",
      "product.updated",
      "variant.updated",
    ]);
  });

  it("refuses anyone without audit access", async () => {
    const customer: SessionUser = { id: owner.id, email: "c@example.com", role: "customer" };
    await expect(listAuditPage(customer)).rejects.toThrow();
  });
});
