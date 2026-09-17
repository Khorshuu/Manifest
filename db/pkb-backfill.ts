/**
 * Imports every listing into the Product Knowledge Base, then prints the
 * reconciliation report (docs/KNOWLEDGE_PLATFORM.md, D-069).
 *
 * Safe to run any number of times: listings already mirrored are no-ops, and
 * nothing is ever marked VERIFIED. Exits 1 when the report is not clean.
 *
 * Run with: npm run pkb:backfill            (the database in DATABASE_URL)
 *           npm run pkb:backfill -- --report (report only, no import)
 */
import "../lib/load-env";
import { backfillKnowledge, knowledgeReport } from "../lib/pkb/maintenance";

async function main() {
  const reportOnly = process.argv.includes("--report");
  if (!reportOnly) {
    const result = await backfillKnowledge({ log: (line) => process.stdout.write(`${line}\n`) });
    process.stdout.write(`Import: ${JSON.stringify(result)}\n`);
  }
  const report = await knowledgeReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(report.ok ? "Knowledge base reconciled.\n" : "Knowledge base NOT reconciled — see above.\n");
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
