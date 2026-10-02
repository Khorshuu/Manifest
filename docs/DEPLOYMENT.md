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

**Product Knowledge Base import (migration 0031).** The migration queues every
existing listing; the `pkb.sync_listings` job imports them in batches without a
manual step. To import at once and check the result, run against the direct
address:

```
DATABASE_URL=<direct address> npm run pkb:backfill
```

It prints a reconciliation report and exits 1 unless every listing and offer is
linked, nothing is queued, no VERIFIED value lacks a claim, and every listing's
structured fields equal what the knowledge base would write back. `-- --report`
prints the report without importing. Re-running is safe.

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
| Any environment with private research or AI services | `npm run worker` on a long-running machine, with `JOB_RUNNER=worker` on it and on the web application (D-133, docs/STAGING.md). The worker is the scheduler; `/api/cron/jobs` declines. Its `DATABASE_URL` is the **direct** address. |
| Development | `npm run dev` starts it with the web server (D-121); `npm run jobs:dev` alone, beside `npm run dev:web`, for debugging. Both need the server's `CRON_SECRET`. |

**Checking it.** Each call records a heartbeat. The admin overview warns the
owner when the scheduler has not called in for three of the shortest intervals
(at least 10 minutes); `GET /api/admin/jobs` returns the same under
`scheduler`, with the effective schedule and any ignored `JOB_SCHEDULE`
entries. Logs carry `jobs.trigger` per call and `jobs.schedule_invalid`
when the variable has a mistake.

## Product preparation, and its optional research provider (D-112, D-114)

Product preparation runs entirely on the existing job runner. There is nothing
new to schedule: `catalog.prepare_product` is enqueued when somebody starts a
run and re-enqueues itself while it waits, so it needs the same scheduler
trigger as everything else. A run that is waiting for a person consumes nothing.

**Automatic source discovery is off by default and that is a supported state.**
With no provider set, preparation still finds sources in the Brand Source
Registry, in the addresses staff attach to a product and in the documents they
provide, and reports the automatic part as NOT_CONFIGURED rather than pretending
to have searched.

| Variable | Default | What it does |
|---|---|---|
| `PRODUCT_RESEARCH_PROVIDER` | `none` | `none` or `brave`. `brave` turns on discovery of candidate source addresses. |
| `BRAVE_SEARCH_API_KEY` | unset | Required when the provider is `brave`. Create one at api-dashboard.search.brave.com. Server-side only; it reaches no browser. |

Without the key, a `brave` provider reports UNAVAILABLE and every run carries on
with the sources it already has. A discovered address is only an address: it is
still fetched through the SSRF-guarded fetcher, checked against robots.txt,
matched against the product's own identifiers and proposed as a claim a person
accepts.

**Not exercised against the real service.** The provider has never made a
request to Brave's API in this repository, because no key exists here. Its
request shape, its failure states and its ordering are covered by tests with a
stand-in. Treat the first real run as an integration test: check
`product_preparation_runs.providers` on a run afterwards, which records exactly
what the provider said about itself.

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

## The build reads the database (Stage 8)

`next build` is not a pure compile. Cache Components prerender a static shell for
every dynamic route, and two routes are built **entirely** from catalogue data:
`/sitemap.xml` and `/api/search/popular`. Their output is written into the build's
cache and then revalidated at runtime — the sitemap every hour, and immediately
whenever a catalogue write drops its cache tags (`lib/cache.ts`).

Two consequences worth knowing before a deploy:

- **The build's `DATABASE_URL` must be the database the deployment serves.**
  `vercel-build` runs `tsx db/migrate.ts && next build`, both against the project's
  own variables, so on Vercel this is automatic. It matters when a build is made
  by hand: a build pointed at one database and started against another serves a
  sitemap describing the first, until the first catalogue write or the hour is up.
  This is how the behaviour was noticed during the Stage 8 audit.
- **A missing listing or shelf answers `200` with `noindex`, not `404`** (R-18,
  D-108). Verified against a production build: an address that matches no route at
  all answers a real 404, and a missing listing or shelf emits no canonical, no
  product structured data, no sitemap entry and no internal link, so it cannot be
  discovered — but an uptime check pointed at a listing that has been withdrawn
  will see a 200. Point uptime checks at `/` or at a listing that is not going
  anywhere, or assert on the page rather than on the status.

## If the migration ledger refuses to run

`db/migrate.ts` stops with "Migration NNNN has changed since it was applied" when
a file's checksum no longer matches what the ledger recorded. That is the rule
working, not a fault to route around, and it happened during the Stage 8 audit:
0041 had been applied to a development database and then edited before it was
committed, so that database was missing one index the committed file creates.

The repair is always in this direction: **fix the database, never the applied
migration.** Replay the committed file's statements against that database — they
are written to be idempotent — and set the recorded checksum to the committed
file's. If the file is not safely replayable, write a corrective migration
instead. Editing the applied file would only move the disagreement to the next
database.

Whether a database is actually in step can be checked rather than assumed: build
one from zero (`npx tsx e2e/prepare-db.ts` does, into `preorder_e2e`) and compare
`information_schema.columns`, `pg_indexes`, `pg_constraint`, `pg_proc.prosrc` and
`pg_trigger` between the two. After the Stage 8 repair, the development database
and a from-zero build agree on all 943 columns, 284 indexes, 1,095 constraints,
79 function bodies and 44 triggers.
