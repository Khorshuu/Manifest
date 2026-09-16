/**
 * Homepage campaigns under real concurrency.
 *
 * All five slides are stored in one settings row. Edits to different slides
 * at the same moment must all survive — they used to read the row, change one
 * slot and write every slot back, so the later write erased the earlier one.
 * Found when both browser projects of the end-to-end suite edited their own
 * slide at once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { getCampaignSettings, updateCampaign } from "@/lib/homepage/campaigns";
import { createRealTestDatabase, realServerAvailable } from "./helpers/real-database";

const available = await realServerAvailable();
let harness: Awaited<ReturnType<typeof createRealTestDatabase>>;
let staff: SessionUser;

beforeAll(async () => {
  if (!available) return;
  harness = await createRealTestDatabase("homepage_concurrency_test", 12);
  const [row] = await harness.db
    .insert(users)
    .values({ email: "homepage@example.test", passwordHash: "x", role: "staff_admin" })
    .returning({ id: users.id, email: users.email });
  staff = { id: row.id, email: row.email, role: "staff_admin" };
}, 180_000);

afterAll(async () => {
  if (!available) return;
  await harness.close();
}, 60_000);

describe.skipIf(!available)("editing different slides at once", () => {
  it("keeps every edit, over several rounds", async () => {
    for (let round = 0; round < 5; round += 1) {
      await Promise.all(
        [0, 1, 2, 3, 4].map((slot) => updateCampaign(staff, slot, { name: `Round ${round} slot ${slot}` })),
      );
      const stored = await getCampaignSettings();
      expect(stored.slides.map((slide) => slide.name)).toEqual(
        [0, 1, 2, 3, 4].map((slot) => `Round ${round} slot ${slot}`),
      );
    }
  }, 120_000);
});

describe.skipIf(available)("homepage concurrency (skipped)", () => {
  it("needs the PostgreSQL server from `npm run db:server`", () => {
    expect(available).toBe(false);
  });
});
