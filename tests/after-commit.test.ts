/**
 * Work queued inside a transaction runs only after it commits (db/index.ts) —
 * what makes cache invalidation from the audit log race-free.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, runAfterCommit } from "@/db";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe("runAfterCommit", () => {
  it("runs queued work after the commit, not before", async () => {
    const events: string[] = [];
    await db.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      expect(runAfterCommit(() => events.push("after commit"))).toBe(true);
      events.push("still inside");
    });
    events.push("returned");
    expect(events).toEqual(["still inside", "after commit", "returned"]);
  });

  it("drops queued work when the transaction rolls back", async () => {
    const events: string[] = [];
    await expect(
      db.transaction(async () => {
        runAfterCommit(() => events.push("should not run"));
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(events).toEqual([]);
  });

  it("reports that there is nothing to wait for outside a transaction", () => {
    expect(runAfterCommit(() => undefined)).toBe(false);
  });

  it("runs a savepoint's work when the outer transaction commits", async () => {
    const events: string[] = [];
    await db.transaction(async (tx) => {
      await tx.transaction(async () => {
        runAfterCommit(() => events.push("inner work"));
      });
      events.push("outer still open");
    });
    expect(events).toEqual(["outer still open", "inner work"]);
  });
});
