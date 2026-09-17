/**
 * Admin pages at scale, over HTTP, signed in as the scratch database's owner.
 *
 *   DATABASE_URL=postgres://…/manifest_scale npx tsx scripts/perf/admin-load.ts \
 *     --base http://localhost:3100 [--runs 5]
 *
 * Refuses anything but a scratch database (db/scratch-guard.ts), because it
 * gives the seeded owner account a known password. Reports, per page, the
 * median and worst response time over --runs sequential requests and the HTML
 * size, so a page that loads a whole table shows up as slow or heavy.
 */
import postgres from "postgres";
import { assertScratchDatabase } from "../../db/scratch-guard";
import { hashPassword } from "../../lib/auth/password";

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const base = option("base", "http://localhost:3100");
const runs = Number(option("runs", "5"));
const databaseUrl = process.env.DATABASE_URL ?? "";
const PASSWORD = "scale-owner-password";

async function main() {
  assertScratchDatabase(databaseUrl);

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const [owner] = await sql<{ id: string; email: string }[]>`
    select id, email from users where role = 'super_admin' order by created_at limit 1`;
  if (!owner) throw new Error("No owner in this database; run npm run db:seed:scale first.");
  await sql`update users set password_hash = ${await hashPassword(PASSWORD)} where id = ${owner.id}`;
  const [variantHeavy] = await sql<{ id: string }[]>`
    select product_id as id from product_variants group by product_id order by count(*) desc limit 1`;
  const [order] = await sql<{ id: string }[]>`select id from orders order by placed_at desc limit 1`;
  await sql.end();

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: owner.email, password: PASSWORD }),
    redirect: "manual",
  });
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(";")[0])
    .join("; ");
  if (!login.ok || !cookie) throw new Error(`sign-in failed: ${login.status} ${await login.text()}`);

  const paths = [
    "/admin",
    "/admin/orders",
    "/admin/orders?status=placed",
    "/admin/customers",
    "/admin/customers?page=400",
    "/admin/products",
    `/admin/products/${variantHeavy.id}`,
    `/admin/products/${variantHeavy.id}/variants`,
    `/admin/orders/${order.id}`,
    "/admin/audit",
    "/admin/audit?page=400",
    "/admin/reviews",
    "/admin/analytics",
    "/admin/notifications",
    "/admin/search",
    "/admin/staff",
    "/admin/categories",
    "/admin/settings",
    "/admin/homepage",
  ];

  for (const path of paths) {
    const samples: number[] = [];
    let status = 0;
    let bytes = 0;
    for (let run = 0; run <= runs; run += 1) {
      const started = performance.now();
      const response = await fetch(base + path, { headers: { cookie }, redirect: "manual" });
      const body = await response.text();
      // The first request warms compilation and caches; it is not counted.
      if (run > 0) samples.push(performance.now() - started);
      status = response.status;
      bytes = body.length;
    }
    samples.sort((a, b) => a - b);
    console.log(
      `${path.padEnd(64)} ${status}  p50 ${String(Math.round(samples[Math.floor(samples.length / 2)])).padStart(5)}ms  max ${String(Math.round(samples.at(-1)!)).padStart(5)}ms  html ${Math.round(bytes / 1024)}KB`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
