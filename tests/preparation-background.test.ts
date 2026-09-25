/**
 * A preparation run whose job nothing picks up (D-121).
 *
 * The Glorious and Revlon runs both sat at "Identifying product — Working…"
 * while their first job stayed queued, because nothing was calling the job
 * trigger. The run now says it is waiting for the background service, from
 * the scheduler's existing heartbeat, and carries on — the same run — once
 * the scheduler calls again. Against a real database.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobs, productPreparationRuns, products, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { createCategory, createProduct } from "@/lib/catalog";
import { JOB_HANDLERS } from "@/lib/jobs/registry";
import { runDueJobs } from "@/lib/jobs/runner";
import { JOB_TRIGGER, recordSchedulerRun } from "@/lib/jobs/schedule";
import { assessBackground, backgroundGraceMs } from "@/lib/preparation/background";
import { getPreparation, getPreparationRun, PREPARATION_JOB, startPreparation } from "@/lib/preparation";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
const staff: SessionUser = { id: "", email: "staff@example.com", role: "staff_admin" };
let categoryId = "";
let keys = 0;
const requestKey = () => `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`;
const MINUTE = 60_000;

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "s".repeat(32);
  process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/unused";
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  const [row] = await harness.db
    .insert(users)
    .values({ email: "staff@example.com", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id });
  staff.id = row.id;
  const category = await createCategory(staff, { name: "Beauty", slug: `beauty-${++keys}` });
  categoryId = category.id;
});

/** A product and its preparation run, whose first job is queued and never claimed. */
async function queuedRun(options: { dueMinutesAgo: number }) {
  const product = await createProduct(staff, {
    categoryId,
    title: "Revlon Colorsilk Hair Color - Black",
    brand: "Revlon",
  } as Parameters<typeof createProduct>[1]);
  const run = await startPreparation(staff, product.id, { requestKey: requestKey() });
  await harness.db
    .update(jobs)
    .set({ runAt: new Date(Date.now() - options.dueMinutesAgo * MINUTE) })
    .where(eq(jobs.kind, PREPARATION_JOB));
  return { productId: product.id, runId: run.id };
}

describe("the rule", () => {
  const now = new Date("2026-09-25T16:00:00Z");
  const due = (minutesAgo: number) => ({ runAt: new Date(now.getTime() - minutesAgo * MINUTE) });

  it("waits three scheduler intervals, and never less than two minutes", () => {
    expect(backgroundGraceMs(1)).toBe(3 * MINUTE);
    expect(backgroundGraceMs(null)).toBe(3 * MINUTE);
    expect(backgroundGraceMs(5)).toBe(15 * MINUTE);
  });

  it("is running when nothing is waiting, or a job has only just become due", () => {
    expect(assessBackground({ waitingJob: null, lastHeartbeatAt: null, expectedEveryMinutes: 1, now })).toBe("running");
    expect(assessBackground({ waitingJob: due(0.1), lastHeartbeatAt: null, expectedEveryMinutes: 1, now })).toBe("running");
    expect(assessBackground({ waitingJob: due(2), lastHeartbeatAt: null, expectedEveryMinutes: 1, now })).toBe("running");
  });

  it("is running while the scheduler keeps calling, even behind a long queue", () => {
    const heartbeat = new Date(now.getTime() - 10_000);
    expect(assessBackground({ waitingJob: due(20), lastHeartbeatAt: heartbeat, expectedEveryMinutes: 1, now })).toBe("running");
  });

  it("is waiting when a due job has not been taken and the scheduler has not called since", () => {
    expect(assessBackground({ waitingJob: due(4), lastHeartbeatAt: null, expectedEveryMinutes: 1, now })).toBe("waiting_for_background");
    const before = new Date(now.getTime() - 30 * MINUTE);
    expect(assessBackground({ waitingJob: due(15), lastHeartbeatAt: before, expectedEveryMinutes: 1, now })).toBe("waiting_for_background");
  });
});

describe("a preparation run nothing picks up", () => {
  it("says Preparing as normal while the scheduler is calling", async () => {
    const { productId } = await queuedRun({ dueMinutesAgo: 20 });
    await recordSchedulerRun(JOB_TRIGGER, {}, new Date());
    const view = await getPreparation(staff, productId);
    expect(view?.stage).toBe("IDENTIFYING");
    expect(view?.background).toBe("running");
  });

  it("says a job taking a few seconds is simply running", async () => {
    const { productId } = await queuedRun({ dueMinutesAgo: 0 });
    expect((await getPreparation(staff, productId))?.background).toBe("running");
  });

  it("says it is waiting for the background service once the scheduler has stopped calling", async () => {
    const { productId, runId } = await queuedRun({ dueMinutesAgo: 20 });
    await recordSchedulerRun(JOB_TRIGGER, {}, new Date(Date.now() - 60 * MINUTE));
    const view = await getPreparation(staff, productId);
    expect(view?.id).toBe(runId);
    expect(view?.background).toBe("waiting_for_background");
    expect((await getPreparationRun(staff, runId))?.background).toBe("waiting_for_background");
  });

  it("creates no second run, and a refreshed page finds the same one", async () => {
    const { productId, runId } = await queuedRun({ dueMinutesAgo: 20 });
    for (let refresh = 0; refresh < 3; refresh += 1) {
      expect((await getPreparation(staff, productId))?.id).toBe(runId);
    }
    // Pressing the button again while it waits returns the waiting run.
    const again = await startPreparation(staff, productId, { requestKey: requestKey() });
    expect(again.id).toBe(runId);
    expect(await harness.db.select().from(productPreparationRuns).where(eq(productPreparationRuns.productId, productId))).toHaveLength(1);
    expect(await harness.db.select().from(jobs).where(eq(jobs.kind, PREPARATION_JOB))).toHaveLength(1);
  });

  it("carries on, as the same run, once the scheduler calls again", async () => {
    const { productId, runId } = await queuedRun({ dueMinutesAgo: 20 });
    expect((await getPreparation(staff, productId))?.background).toBe("waiting_for_background");

    // The scheduler is back: this is what /api/cron/jobs does on each call.
    await runDueJobs(JOB_HANDLERS, { budgetMs: 10_000 });
    await recordSchedulerRun(JOB_TRIGGER, {}, new Date());

    const [first] = await harness.db.select().from(jobs).where(eq(jobs.kind, PREPARATION_JOB)).orderBy(jobs.createdAt).limit(1);
    expect(first.status).toBe("succeeded");
    const view = await getPreparation(staff, productId);
    expect(view?.id).toBe(runId);
    expect(view?.stage).not.toBe("IDENTIFYING");
    expect(view?.background).toBe("running");
    const [product] = await harness.db.select().from(products).where(eq(products.id, productId));
    expect(product.title).toBe("Revlon Colorsilk Hair Color - Black");
  });
});

describe("production scheduling", () => {
  it("is unchanged: the hosted scheduler calls the same trigger, and nothing runs jobs on requests", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string }[] };
    expect(vercel.crons.map((cron) => cron.path)).toContain("/api/cron/jobs");
    const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.build).toBe("next build");
    expect(scripts.start).toBe("next start");
    // Reading preparation only reads: no job is run or enqueued by it.
    expect(readFileSync("lib/preparation/background.ts", "utf8")).not.toMatch(/runDueJobs|enqueueJob/);
  });
});
