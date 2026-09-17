# Deployment and database operations

How the production database is connected, migrated and looked after. Written
for whoever sets up or runs the production environment. Items marked
**Unverified** need access to the production Neon project, which the
development environment does not have.

## Connections

The application runs on Vercel, where every function instance holds its own
connection pool, and Neon PostgreSQL sits behind Neon's transaction pooler.

| Variable | Value | Used by |
|---|---|---|
| `DATABASE_URL` | Neon's **pooled** address (host contains `-pooler`) | The application (`db/index.ts`) |
| `DATABASE_URL_UNPOOLED` | Neon's **direct** address | Migrations (`db/migrate.ts`, run by `vercel-build`) |
| `DATABASE_POOL_MAX` | Leave unset (3 per instance on Vercel) | `db/connection.ts` |
| `DATABASE_PREPARE` | `auto` | Prepared statements off behind the pooler |

Why:

- **Pool size.** Total connections are pool size × running instances. Neon's
  pooler accepts many client connections and multiplexes them onto a small
  number of server connections, but only if each instance keeps a small pool.
  Raising `DATABASE_POOL_MAX` does not make a busy site faster; it moves the
  bottleneck to the database's connection limit.
- **Idle timeout.** On Vercel, idle connections close after 20 seconds, so
  quiet or frozen instances do not hold server connections.
- **Prepared statements.** A transaction pooler may run consecutive
  statements on different server connections, so named prepared statements are
  off when the address is pooled. Transactions stay on one connection, so row
  locks (`SELECT … FOR UPDATE`) and the application's advisory locks
  (`pg_advisory_xact_lock`, all transaction-scoped) behave as on a direct
  connection (`tests/db-connection.test.ts`).
- **Migrations use the direct address.** The migrator takes a *session*
  advisory lock so two deploys cannot migrate at once; through a transaction
  pooler the lock and its release could reach different server connections.
  `db/migrate.ts` refuses a pooled address.

## Migrations

`vercel-build` runs `tsx db/migrate.ts && next build`. Each file in
`db/migrations` is applied once, in a transaction, and recorded with its
checksum in `schema_migrations` (DECISIONS.md, migration ledger). An edited,
already-applied migration fails the deploy rather than being skipped. With
`ADMIN_EMAIL` and `ADMIN_PASSWORD` set, the first run creates the owner account.

## Scheduled work

Background jobs run from the `jobs` table only when `/api/cron/jobs` is
called with `Authorization: Bearer <CRON_SECRET>` (DECISIONS.md D-053, D-059).
Site traffic never runs them.

**Intervals.** Defaults live in `lib/jobs/registry.ts`: notification delivery
every minute, unpaid-order expiry every 2, publish dates every 5, payment
reconciliation and search repair every 10, SKU holds every 15, pruning and the
media sweep hourly. Override per environment with `JOB_SCHEDULE`, for example
on staging:

```
JOB_SCHEDULE="media.sweep_unreferenced=off,payments.reconcile=30"
```

**Trigger.** The scheduler must call at least as often as the shortest interval
left on (every minute with the defaults):

| Environment | Trigger |
|---|---|
| Production on a Vercel paid plan | `vercel.json`: change the `/api/cron/jobs` schedule to `* * * * *`. |
| Production on Vercel Hobby | Vercel allows only a daily cron: use a cron service (for example cron-job.org or Upstash QStash schedules) calling the endpoint every minute. |
| Staging (a Vercel preview or separate project) | Vercel runs no cron on previews: enable `.github/workflows/scheduler.yml` for the `staging` environment (every 5 minutes; set `JOB_SCHEDULE` so nothing needs more often), or a cron service. |
| Development | `npm run jobs:dev` with the server's `CRON_SECRET`. |

**Checking it.** Each call records a heartbeat. The admin overview warns the
owner when the scheduler has not called in for three of the shortest intervals
(at least 10 minutes); `GET /api/admin/jobs` returns the same under
`scheduler`, with the effective schedule and any ignored `JOB_SCHEDULE`
entries. Logs carry `jobs.trigger` per call and `jobs.schedule_invalid`
when the variable has a mistake.

## Tables that grow and how they are kept in check

| Table | Growth | Kept in check by |
|---|---|---|
| `rate_limit_hits` | One row per key per window | `maintenance.prune` (hourly job) deletes closed windows |
| `sessions` | One row per sign-in | `maintenance.prune` deletes expired sessions |
| `search_queries`, `search_clicks` | Every search and result click | `maintenance.prune` deletes after 180 days |
| `jobs` | Every scheduled run | `maintenance.prune`: succeeded after 7 days, dead after 30 |
| `carts`, `cart_items` (guests) | Every visitor who adds something | `maintenance.prune` deletes guest carts older than their 60-day cookie |
| `media_objects` / stored files | Every upload | `media.sweep_unreferenced` (hourly) |
| `audit_log`, `notifications`, `orders` | Business records | Kept (owner decision: records stay); indexed for paging |

## Backups, recovery and monitoring — **Unverified**

To confirm in the Neon console before launch:

1. **Point-in-time restore window** is long enough for the business (Neon's
   history retention setting on the project).
2. **A restore has been rehearsed**: branch from a past timestamp, run
   `npm run db:migrate` against the branch's direct address, open the site
   against it.
3. **`pg_stat_statements`** is enabled, and slow statements are reviewed after
   launch week:
   `select calls, mean_exec_time, query from pg_stat_statements order by total_exec_time desc limit 20;`
4. **Autovacuum keeps up** on the churn tables above:
   `select relname, n_live_tup, n_dead_tup, last_autovacuum from pg_stat_user_tables order by n_dead_tup desc limit 10;`
   Per-table autovacuum settings were deliberately not added without
   production statistics to justify them.
5. **Connection count** stays well under the compute size's limit at peak:
   `select count(*) from pg_stat_activity;`
