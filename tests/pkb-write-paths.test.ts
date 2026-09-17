/**
 * Risk R-5: a new catalogue write path that forgets the knowledge mirror.
 *
 * `pkb-sync.test.ts` proves the paths that exist today leave nothing queued.
 * This test is the guard for the ones written later: it reads the source of
 * `lib/catalog` and fails when a function writes a listing, a variant or its
 * option values without either taking the knowledge lock (`beginListingChange`)
 * or syncing inside the same transaction (`syncListingKnowledge`).
 *
 * It is deliberately a source check. The alternative — running every future
 * write path — cannot be written in advance.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CATALOG_DIR = join(process.cwd(), "lib", "catalog");

/**
 * Tables whose rows carry a mirrored value that is attributed to whoever
 * changed it. A write to one of these outside the mirror is reverted as an
 * unattributed change, so the path must sync inside its own transaction.
 *
 * The option vocabulary (`attributes`, `attribute_values`) and the category
 * specifications are deliberately not here: the database triggers queue the
 * listings they affect, and the sync job picks the change up (D-070).
 */
const MIRRORED = ["products", "productVariants", "variantOptionValues"];

const WRITE = /\.(insert|update|delete)\(\s*([A-Za-z]+)\s*\)/g;

/**
 * Files that write a mirrored table only in ways the mirror does not care
 * about, with the reason. Adding a file here is a decision, not a workaround:
 * it says the writes inside cannot change a mirrored value.
 */
const EXEMPT: Record<string, string> = {
  "sku.ts": "Writes permanent SKU records and reservations, not mirrored columns.",
  "readiness.ts": "Reads only.",
  "schedule.ts": "Moves a listing's status; status is not mirrored knowledge.",
};

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(CATALOG_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(CATALOG_DIR, name), "utf8") }));
}

describe("catalogue write paths keep the knowledge mirror in step", () => {
  it("every file that writes a mirrored table also locks or syncs it", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (EXEMPT[file.name]) continue;
      const writes = [...file.text.matchAll(WRITE)].map((match) => match[2]).filter((table) => MIRRORED.includes(table));
      if (writes.length === 0) continue;

      const guarded =
        file.text.includes("beginListingChange") ||
        file.text.includes("syncListingKnowledge") ||
        file.text.includes("syncLegacyFamilies") ||
        file.text.includes("releaseListingKnowledge");
      if (!guarded) {
        offenders.push(`${file.name} writes ${[...new Set(writes)].join(", ")} without touching the knowledge mirror`);
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("names the files it deliberately skips, so the list stays honest", () => {
    const names = sourceFiles().map((file) => file.name);
    for (const exempt of Object.keys(EXEMPT)) {
      expect(names, `${exempt} is exempt but no longer exists`).toContain(exempt);
    }
  });
});
