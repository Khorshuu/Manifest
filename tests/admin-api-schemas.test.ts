/**
 * Stage 7: every admin API route refuses a field it does not expect.
 *
 * SECURITY.md has promised since Phase 14 that "a request carrying an extra
 * field is refused with 400, including a registration trying to set its own
 * role". The routes written in Phases 1 to 14 keep that promise. Twelve of the
 * routes added by the knowledge and SEO stages did not: their schemas were
 * plain `z.object`, which *strips* an unexpected field instead of refusing it.
 *
 * Nothing was assignable through the gap — Zod removes what it strips, so an
 * extra field never reached a write — but a documented guarantee that holds
 * for most of the surface is worse than one that holds everywhere, and a
 * silently ignored field is how a staff typo becomes "the button does nothing".
 *
 * This is a source check for the same reason `pkb-write-paths.test.ts` is one:
 * it has to cover routes that do not exist yet.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ADMIN_API = join(process.cwd(), "app", "api", "admin");

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}

describe("admin request schemas", () => {
  it("are strict, so an unexpected field is refused rather than ignored", () => {
    const loose: string[] = [];

    for (const path of routeFiles(ADMIN_API)) {
      const source = readFileSync(path, "utf8");
      // Each `z.object(` opens an object schema. Find where its own `)`
      // closes and look for `.strict()` immediately after.
      for (let at = source.indexOf("z.object("); at !== -1; at = source.indexOf("z.object(", at + 1)) {
        let depth = 0;
        let end = -1;
        for (let index = at + "z.object".length; index < source.length; index += 1) {
          const character = source[index];
          if (character === "(") depth += 1;
          else if (character === ")") {
            depth -= 1;
            if (depth === 0) {
              end = index;
              break;
            }
          }
        }
        if (end === -1) continue;
        if (!/^\s*\.strict\(\)/.test(source.slice(end + 1))) {
          const line = source.slice(0, at).split("\n").length;
          loose.push(`${relative(process.cwd(), path)}:${line}`);
        }
      }
    }

    expect(loose).toEqual([]);
  });

  it("every route refuses a non-staff caller before it reads the body", () => {
    // The other half of the same boundary: validating first tells a customer
    // which fields an admin endpoint expects, and turns an unparseable body
    // into a 500 rather than a 403.
    const unguarded: string[] = [];

    for (const path of routeFiles(ADMIN_API)) {
      const source = readFileSync(path, "utf8");
      if (!/refuseNonStaff|requireAdmin|getCurrentUser/.test(source)) {
        unguarded.push(relative(process.cwd(), path));
        continue;
      }
      const guardAt = source.indexOf("refuseNonStaff()");
      const bodyAt = source.search(/request\.(json|formData)\(\)/);
      if (guardAt !== -1 && bodyAt !== -1 && bodyAt < guardAt) {
        unguarded.push(`${relative(process.cwd(), path)}: reads the body before the guard`);
      }
    }

    expect(unguarded).toEqual([]);
  });
});
