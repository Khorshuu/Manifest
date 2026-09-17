# Staging validation on Vercel and Neon

The final production check runs on a Vercel staging deployment backed by a
Neon branch: the same hosting, pooler, caching and cron behaviour production
will have. This is the runbook. Every step that needs the owner's Vercel or
Neon account is marked **BLOCKED** until access is given; nothing below has
been run against hosted infrastructure yet.

Written for whoever sets up and runs staging.

## Safety rules

- Staging never uses the production database or production secrets. It gets
  its own Neon branch and its own `SESSION_SECRET`, `CRON_SECRET` and webhook
  secrets.
- The end-to-end suite creates accounts and places orders, and
  `e2e/prepare-db.ts` **drops and recreates** its database. It refuses any
  database whose name does not contain `_e2e` or `_test`, refuses when
  `NODE_ENV` or `VERCEL_ENV` is `production`, and refuses a remote host unless
  `E2E_ALLOW_REMOTE_DATABASE=1` (`db/scratch-guard.ts`). Set that flag only for
  the staging branch.
- `db/seed-scale.ts` and the benchmark scripts refuse anything not named as
  scratch (`_scale`, `_bench`, `_perf`, `_load`) and any remote host unless
  `SCALE_SEED_ALLOW_REMOTE=1`.
- Payments and couriers stay on the mock providers in staging until real
  sandbox credentials exist (PRODUCTION-READINESS 24.1, 25.1).

## 1. Neon — BLOCKED on Neon access

1. Create a branch from the production project named `staging` (or a
   separate project).
2. In it, create a database named `preorder_e2e` for the end-to-end run, and
   optionally `manifest_load` for load testing with scale data.
3. Note both connection strings for each: the pooled one (`-pooler` host) and
   the direct one.
4. Enable `pg_stat_statements` on the branch.

## 2. Vercel — BLOCKED on Vercel access

Use a separate Vercel project (or a custom environment) for staging, so its
environment variables and cron are its own. Environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** address of `preorder_e2e` |
| `DATABASE_URL_UNPOOLED` | Neon **direct** address of `preorder_e2e` (migrations) |
| `SESSION_SECRET` | New random value, 32+ characters |
| `CRON_SECRET` | New random value |
| `PAYMENT_PROVIDER` | `mock` |
| `SITE_URL` | The staging address |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT=staging` | From the Sentry project (BLOCKED on Sentry account) |
| `JOB_SCHEDULE` | Match the scheduler's frequency, e.g. `notifications.deliver=5,orders.expire_unpaid=5` if GitHub Actions calls every 5 minutes |
| `LOGIN_RATE_LIMIT_PER_IP`, `LOGIN_RATE_LIMIT_PER_ACCOUNT`, `SEARCH_SUGGEST_LIMIT`, `SEARCH_CLICK_LIMIT`, `CHECKOUT_RATE_LIMIT_PER_IP`, `CHECKOUT_RATE_LIMIT_PER_EMAIL`, `REGISTER_RATE_LIMIT_PER_IP`, `ORDER_LOOKUP_RATE_LIMIT_PER_IP` | `100000` **only while the end-to-end suite runs** (every browser in it is one visitor); reset to defaults afterwards and re-check the limits |

If Deployment Protection is on, create an automation bypass secret; the
suite and the performance scripts send it when
`VERCEL_AUTOMATION_BYPASS_SECRET` is set.

`vercel-build` migrates through `DATABASE_URL_UNPOOLED` before building.

## 3. Scheduler — BLOCKED on the hosting plan

Vercel runs cron only on a project's production deployment, daily on Hobby.
For staging, either give the staging project its own cron (paid plan) or
enable `.github/workflows/scheduler.yml` for the `staging` GitHub environment
(secrets `CRON_URL`, `CRON_SECRET`; variable `STAGING_SCHEDULER=github-actions`).
See docs/DEPLOYMENT.md, "Scheduled work".

**Check:** within 15 minutes the admin overview (as the owner) shows no
"Scheduled jobs are not running" warning, and `GET /api/admin/jobs` returns
`scheduler.stale: false`. Place an order and leave it unpaid; it is cancelled
after the configured hold (`orders.unpaid_hold_minutes`, 30 by default) plus at
most one scheduler interval.

## 4. End-to-end suite against staging

From a machine with the direct Neon address:

```sh
# Recreate and seed the staging e2e database (drops it).
E2E_ADMIN_DATABASE_URL="<direct address of the staging branch>/neondb" \
E2E_DATABASE_NAME=preorder_e2e E2E_ALLOW_REMOTE_DATABASE=1 \
  npx tsx e2e/prepare-db.ts

# Run the suite against the deployment; no local server is started.
E2E_REMOTE=1 E2E_BASE_URL=https://<staging address> \
E2E_CRON_SECRET=<staging CRON_SECRET> \
VERCEL_AUTOMATION_BYPASS_SECRET=<bypass secret, if protected> \
  npx playwright test
```

Redeploy (or wait for connections to drop) after recreating the database, so
no function holds a connection to the dropped one.

**Record:** passed / failed / flaky per project, and any failure that does not
happen locally — those are the hosting-specific findings this run exists for
(serverless timeouts, cold starts, cache behaviour).

## 5. Caching and serverless behaviour

- `curl -sI https://<staging>/categories/<slug>` twice: the page is rendered per
  request (the CSP nonce differs between responses), and repeat catalogue
  requests are fast because the `use cache` entries are shared (D-054).
- As staff, change a price; the product page and category show the new price
  on the next request (cache tags invalidated after commit).
- Signed in as one customer, then another: the header and cart never show the
  other customer's data (`e2e/cache-isolation.spec.ts` covers this in the
  suite run above).
- Vercel function logs: `request.failed` lines should be absent; note cold-start
  durations from the first requests after a deploy.

## 6. Database connections under load

```sh
VERCEL_AUTOMATION_BYPASS_SECRET=<secret> node scripts/perf/http-load.mjs \
  --base https://<staging> --concurrency 20 --requests 400 \
  --db "<direct address of the staging database>" \
  --paths "/,/categories/<slug>,/search?q=<word>,/products/<slug>,/cart"
```

`--db` samples `pg_stat_activity` during the run. Expect every page 0% errors
and connections well under the Neon pooler's limit; each function instance
opens at most 3 (`db/connection.ts`). Repeat at concurrency 50. Compare with the
local figures in PRODUCTION-READINESS 26.1 and record both.

Then in the Neon SQL editor:

```sql
select calls, round(mean_exec_time::numeric, 1) as mean_ms, left(query, 120)
from pg_stat_statements order by total_exec_time desc limit 15;
```

## 7. Performance budgets and mobile vitals

```sh
VERCEL_AUTOMATION_BYPASS_SECRET=<secret> npm run perf:budget -- --base https://<staging> \
  --paths "/,/categories/<slug>,/search?q=<word>,/products/<slug>,/cart,/login"
npm run perf:vitals -- --base https://<staging> --paths "/,/products/<slug>"
```

The vitals script drives a real browser and does not send the bypass header;
run it while Deployment Protection is off, or against a production-like
deployment without protection.

## 8. Error tracking — BLOCKED on a Sentry account

With `SENTRY_DSN` set on staging, set `JOB_SCHEDULE=not_a_job=1` for one
scheduler call: Sentry should receive one `jobs.schedule_invalid` event tagged
with a request id, and it should contain no cookie, secret or email. Remove the
variable afterwards.

## Sign-off record

| Check | Result | Date | By |
|---|---|---|---|
| Scheduler heartbeat healthy for 24 h | | | |
| Unpaid order expired on time | | | |
| End-to-end suite (mobile / desktop) | | | |
| Cache invalidation and isolation | | | |
| Load test c=20 / c=50, errors and peak connections | | | |
| Budgets and vitals | | | |
| Sentry event received and scrubbed | | | |
| Rate limits restored to defaults | | | |
