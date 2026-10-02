# Staging: infrastructure and validation

How Manifest runs as a hosted staging environment that does not depend on
anybody's computer, and how that environment is checked. Written for whoever
sets up and runs staging.

Part 1 is the infrastructure: what runs where, how it is configured, and what
is still missing. Part 2 is the validation runbook that is run against it.

**Status.** The application side is built and tested (DECISIONS.md D-132,
D-133). No hosted staging environment exists yet: no managed database, worker
machine, GPU, email service or staging media store has been created, because
each needs an account only the owner can open. Everything below that needs
one is marked **NEEDED**. `deploy/` holds templates that have not been run.

## Part 1 — Infrastructure

### A. Services

```
                        shoppers and staff
                               │
                        ┌──────▼──────┐
                        │  Cloudflare │  DNS, TLS, caching                 PUBLIC
                        └──────┬──────┘
                        ┌──────▼──────┐
                        │   Vercel    │  Next.js: storefront, admin, APIs   PUBLIC
                        └───┬─────┬───┘
            pooled address  │     │  Vercel Blob (media)
                        ┌───▼─────▼───┐
                        │  PostgreSQL │  managed, database manifest_staging PRIVATE
                        └──────▲──────┘
             direct address    │
   ┌───────────────────────────┴────────────────────────────────────────┐
   │ research machine (NVIDIA GPU) — nothing listens on the internet     │
   │                                                                     │
   │   ┌────────────┐   http://searxng:8080    ┌──────────┐              │
   │   │   worker   ├─────────────────────────▶│ SearXNG  │──▶ search    │
   │   │ npm run    │                          └──────────┘    engines   │
   │   │  worker    │   http://ollama:11434    ┌──────────┐              │
   │   │            ├─────────────────────────▶│  Ollama  │ qwen2.5:7b   │
   │   │ job queue  │                          └──────────┘              │
   │   │ crawler    │                                                    │
   │   │ Chromium   │──▶ manufacturer pages (safeFetch, robots.txt)      │
   │   └─────┬──────┘                                                    │
   └─────────┼───────────────────────────────────────────────────────────┘
             ├──▶ email service (SMTP, TLS)
             └──▶ Vercel: POST /api/cron/revalidate (cache tags)
```

| Service | What it is | Runs |
|---|---|---|
| Web application | The Next.js app: storefront, admin, APIs | Vercel |
| Database | Managed PostgreSQL, one database per environment | Neon (or any managed Postgres) |
| Worker | `npm run worker`: the job queue, scheduled work, message delivery, crawler, browser renderer | The research machine |
| SearXNG | Web search for product research | The research machine, private |
| Ollama | The model for SeoPulse and prose extraction | The research machine, on its GPU, private |
| Media | Product photographs | Vercel Blob, one store per environment |
| Email | Transactional email over SMTP | Any transactional email service |
| Cloudflare | DNS and TLS in front of Vercel | Cloudflare |

With the owner's computer off, every one of these keeps running: nothing in
the table is on it.

### B. Environment variables

`.env.example` lists every name, grouped as APP / DATABASE, BACKGROUND JOBS,
MEDIA, NOTIFICATIONS, RESEARCH, SEARXNG, OLLAMA, SEO PULSE, SEARCH CONSOLE,
PAYMENT, SHIPPING, SIGN-IN and OBSERVABILITY. Values live only in the hosts'
own settings — Vercel's for the web application, the worker machine's
`.env.staging` (never committed) for the worker. Nothing secret goes in Git,
`.env.example`, this document or a test.

What staging sets, and where:

| Variable | Web application (Vercel) | Worker |
|---|---|---|
| `DATABASE_URL` | **pooled** address of `manifest_staging` | **direct** address of `manifest_staging` |
| `DATABASE_URL_UNPOOLED` | direct address (migrations at build) | — |
| `SESSION_SECRET` | new random value | same value |
| `CRON_SECRET` | new random value | same value |
| `SITE_URL` | the staging address | same value |
| `JOB_RUNNER` | `worker` | `worker` |
| `NOTIFICATION_PROVIDER`, `SMTP_*`, `EMAIL_FROM*` | set | same values |
| `NOTIFICATION_RECIPIENT_ALLOWLIST` | the testers' addresses | same value |
| `MEDIA_PROVIDER=blob`, `BLOB_READ_WRITE_TOKEN` | the staging store's | same values |
| `PRODUCT_RESEARCH_PROVIDER=local` | set | set |
| `PRODUCT_EXTRACTION_PROVIDER=ollama` | set | set |
| `SEO_PULSE_AI_PROVIDER=ollama`, `OLLAMA_MODEL` | set | set |
| `OLLAMA_BASE_URL`, `OLLAMA_ALLOW_REMOTE` | — | `http://ollama:11434`, `true` |
| `SEARXNG_BASE_URL`, `SEARXNG_ALLOW_REMOTE` | — | `http://searxng:8080`, `true` |
| `LOCAL_BROWSER_RENDERER` | — | `playwright` |
| `LOCAL_AI_CONCURRENCY` | — | `1` |
| `PAYMENT_PROVIDER`, `SHIPPING_PROVIDER` | `mock` | `mock` |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT=staging` | when there is a Sentry project | same |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | — | only if Deployment Protection is on |

The provider names are set on the web application as well as the worker
because the web application decides, when staff start a run, whether it must
be queued. It never calls the services themselves, so it needs none of their
addresses.

### C. Public and private

| | Reachable from the internet | Protected by |
|---|---|---|
| Web application | Yes | TLS; sessions; `CRON_SECRET` on `/api/cron/*` |
| Database | Only with its credentials | TLS, the provider's password |
| Worker | **No.** It serves no HTTP and listens on nothing | — |
| SearXNG | **No** | No published port; reachable only from the worker |
| Ollama | **No** | No published port; reachable only from the worker |
| Media | Yes, read-only (photographs are public) | Unguessable names; a write token |

Ollama has no authentication and must never have a port open to the internet.
Three arrangements are supported, in order of preference:

1. **Same private network as the worker** (the `deploy/` template): a service
   name, a private IP or a name under `.internal`, over plain http.
2. **A private overlay network** between two machines (WireGuard and the
   like): a private IP, over plain http inside the tunnel.
3. **Across the public internet**, only when neither is possible: `https://`
   to a reverse proxy that requires a bearer token, with `OLLAMA_AUTH_TOKEN`
   (and `SEARXNG_AUTH_TOKEN`) set on the worker.

The application enforces what it can (`lib/providers/local/config.ts`): a
non-loopback address is refused unless `OLLAMA_ALLOW_REMOTE` /
`SEARXNG_ALLOW_REMOTE` is true, so changing the address alone never sends a
product document anywhere; and a remote address must be on a private network
or use https, so documents and the token never cross the internet in the
clear. It cannot check that a firewall is closed. That is the operator's job.

### D. Database: direct and pooled

Staging has its own database, `manifest_staging`, on a managed server. It is
never the development database, `preorder_e2e`, a scale-test database or
production. The destructive scripts refuse it by name (`db/scratch-guard.ts`).

A managed Postgres gives two addresses. Which process uses which matters:

| Process | Address | Why |
|---|---|---|
| Web application | **Pooled** | Serverless starts many instances; a transaction pooler absorbs them (docs/DEPLOYMENT.md). |
| Migrations (`vercel-build`) | **Direct** (`DATABASE_URL_UNPOOLED`) | The migration lock is a session lock; `db/migrate.ts` refuses a pooled address. |
| Worker | **Direct** (as its `DATABASE_URL`) | The local-AI slot is a session advisory lock held for a whole generation. |

A session advisory lock belongs to one server connection. A transaction pooler
hands each statement to whichever connection is free, so the lock and its
unlock can land on different ones: a slot nobody holds stays taken, or two
generations both believe they hold it and share one graphics card. So the
slot refuses a pooled address (`LOCAL_AI_SLOT_NEEDS_DIRECT_CONNECTION`), and
the worker refuses to start with one while local AI is configured. Everything
else the application locks with is transaction-scoped and works through a
pooler.

The worker is one long-lived process holding at most 10 connections, plus one
per running generation. That is well inside a direct connection limit.

### E. Web command

Vercel builds with `npm run vercel-build` (`tsx db/migrate.ts && next build`)
and serves the result. Nothing is typed. On any other host: `npm run build`,
then `npm run start`.

### F. Worker command

```
npm ci --include=dev
npx playwright-core install --with-deps chromium
npm run worker
```

The worker is the job trigger as a process of its own: the same registry,
runner, claiming (`FOR UPDATE SKIP LOCKED`), heartbeats, stale recovery,
retries and local-AI lane as `/api/cron/jobs`, started on an interval instead
of by a request. It runs everything in the queue: SeoPulse, product
preparation, knowledge-base enrichment, the notification outbox, and the
scheduled jobs (unpaid-order expiry, publish dates, pruning, the media sweep).
There is no separate scheduler process.

With `JOB_RUNNER=worker`, `/api/cron/jobs` on the web application answers 200
and claims nothing, so a leftover cron cannot claim a job that needs services
only the worker can reach. Jobs are claimed with SKIP LOCKED either way: a
mistake here can make a job wait or fail, never run twice. A second worker is
safe for the same reason, though one is enough.

`npm run worker -- --check` prints what the worker can reach and exits;
`-- --once` runs a single tick. Settings: `WORKER_INTERVAL_SECONDS` (15),
`WORKER_MAX_CONCURRENT_TICKS` (3), `WORKER_SHUTDOWN_GRACE_SECONDS` (25).

What the worker changes that shoppers see — a publish date arriving, a
prepared listing — is in the database at once, but the web application caches
catalogue pages. The worker hands the cache tags to
`POST /api/cron/revalidate` (with `CRON_SECRET`); without `SITE_URL` or
`WORKER_WEB_URL` it says so at start, and pages catch up when their cache
lifetime lapses (minutes).

### G. SearXNG

A private SearXNG with JSON output enabled (`deploy/searxng/settings.yml`),
reachable only from the worker. Its rate limiter is off because its one
caller is known; that is exactly why it must not be published. Set
`SEARXNG_BASE_URL` and `SEARXNG_ALLOW_REMOTE=true` on the worker.

Nothing about research changes with where SearXNG runs: English-only results,
bounded result counts, and every address still fetched through `safeFetch`,
checked against robots.txt, matched against the product and proposed to a
person. Development keeps `http://127.0.0.1:8080` with no flag.

### H. GPU and Ollama

- **Machine:** one NVIDIA GPU. 24 GB of video memory is the recommended class
  for headroom; `qwen2.5:7b` needs about 6 GB and fits a 12–16 GB card. The
  application does not know or care which card it is.
- **Model:** `OLLAMA_MODEL=qwen2.5:7b` to start. The `deploy/` template pulls
  it once and keeps it on a volume.
- **Concurrency:** `LOCAL_AI_CONCURRENCY=1`, and Ollama's own
  `OLLAMA_NUM_PARALLEL=1`. Raise it only after benchmarking that card with two
  generations at once; a faster GPU is not by itself a reason.
- **Timeout:** `OLLAMA_TIMEOUT_MS` defaults to 240000. The job's stale window
  and heartbeat are derived from it, so change the one value only.

**When the GPU is not there.** Nothing a shopper touches calls Ollama: the
storefront, accounts, orders and search do not depend on it. Work that needs
it records why it could not have it, with D-127's codes —
`OLLAMA_UNAVAILABLE`, `OLLAMA_MODEL_NOT_FOUND`, `OLLAMA_GENERATION_TIMEOUT`,
`OLLAMA_QUEUE_WAIT_TIMEOUT` and the rest:

- A SeoPulse run finishes with the rules generator's wording, recorded as
  rules with the failure it fell back from. It is never stored as the model's.
- Prose extraction reports that the page's sentences were not read; the
  structured readers' findings stand.
- A job that fails outright is retried with backoff, then left dead where the
  owner can see and retry it.

A partial or malformed answer is never kept.

**On-demand GPUs.** The job queue already works the way a GPU that is switched
on for the work needs: a run is queued by the web application, waits as long
as it must, and is processed when a worker with a model is running. Three
things do not fit that, and are left as follow-up rather than redesigned:

1. Work does not wait for a GPU to start. A SeoPulse run claimed while
   Ollama is unreachable finishes at once with rules wording (and says so);
   staff regenerate it when the model is back. The way round it without a
   code change is to run the worker on the GPU machine itself, as the
   template does: when the machine is off there is no worker, runs stay
   queued, and they are processed when it starts.
2. A document staff paste or upload is read inside the web request, not by a
   job. The web application cannot reach Ollama, so in a hosted environment
   that document is read by the structured readers only and its sentences are
   reported as not read by the model. Pages found by research are read by the
   worker and are not affected. Moving this read to a job is follow-up.
3. A "serverless GPU" endpoint that is not Ollama's API (a provider's own
   request/response format) needs its own provider beside `ollama`. None is
   written.

### I. Notifications

Email goes out through one adapter, SMTP (`NOTIFICATION_PROVIDER=smtp`),
behind the existing provider boundary and outbox. SMTP is what every
transactional email service speaks, so choosing one — or changing it — is a
change of settings and of no code.

**NEEDED:** an account with a transactional email service, a sending domain
verified with it (SPF and DKIM records in Cloudflare DNS), and its SMTP host,
port, user and password. Then set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASSWORD`, `EMAIL_FROM`, and on staging
`NOTIFICATION_RECIPIENT_ALLOWLIST`.

How a message is kept safe:

- It is written to the outbox in the same transaction as the change that
  caused it, with a dedupe key, so an event is told once.
- Delivery claims each row before sending, so two drains never send one
  message twice.
- A failure is recorded on the row and retried after 1, 2, 4, 8, 16, 32 and
  60 minutes — eight attempts over about two hours. A provider that is down
  for an afternoon loses nothing that was queued in its first two hours; after
  that the row is `failed` for good, counted in the health check and shown on
  the admin Notifications screen.
- A failure that cannot clear — no such mailbox, a recipient outside the
  staging allow-list — stops at once.
- Messages are plain text, to one validated recipient, over TLS. Errors are
  recorded by kind; no password, user or host reaches a row or a log.
- SMTP has no idempotency key. A crash between the provider accepting a
  message and the row being marked sent can deliver it twice; both copies
  carry the same Message-ID.

**SMS** is a channel the outbox models and no provider carries. An SMS row
fails with "No SMS provider is configured". Adding one is a second adapter
behind the same interface and a way to route by channel; it is follow-up.

Nothing queues an SMS today, and the only messages that exist are about
orders, payments, refunds and the waitlist. Account and security email
(password reset, sign-in alerts) is not written.

### J. Media

Vercel Blob is the implemented object store (`MEDIA_PROVIDER=blob`).
Cloudflare R2 is named in D-001 and has no provider. Staging gets its **own
Blob store**, linked to the staging Vercel project, so its token cannot reach
another environment's files. **NEEDED:** create that store. Nothing is copied
into it: staging starts with the seed's images or whatever staff upload there.

Local uploads (`.uploads/`), the end-to-end suite's files, staging and
production never share storage: the first two are on a developer's disk, the
last two are separate stores. The worker has the staging token because it runs
the hourly sweep of unreferenced files.

### K. Health

| Check | Who | What it tells |
|---|---|---|
| `GET /` | Anyone | The web application is serving. Point uptime monitors here. |
| `GET /api/cron/health` with `Authorization: Bearer <CRON_SECRET>` | A monitor | Everything below, as JSON. 503 only when the database is unreachable. |
| `GET /api/admin/health` | Signed-in staff | The same report. |
| Admin → Background work | Staff | Every job kind's last run, failures, dead jobs, retry. |
| Admin → Notifications | Staff | The outbox and its failures. |
| `npm run worker -- --check` | On the worker | The same report, from where the private services are reachable. |

The report covers the database (reachable, latency), the job queue (queued,
due, oldest waiting, running, stale, dead, local-AI jobs waiting), whoever
drains it (last run, late or not), the worker (reporting or silent), the
notification provider (it connects and logs in; it sends nothing) and outbox,
SearXNG, Ollama and whether the configured model is installed, the browser
renderer, and which media, payment and shipping providers are in use. `status`
is `ok`, `degraded` (with `problems` in sentences) or `down`.

It carries states and counts only: no address, key, prompt or customer data.
There is no public dashboard.

SearXNG and Ollama are private to the worker, so the web application cannot
ask them. The worker checks about once a minute and records the answer; the
web application reports that, and says "Worker not reporting" when it is more
than five minutes old.

### L. Startup and restart

Nobody types a start command after a reboot.

| Service | Started and restarted by |
|---|---|
| Web application | Vercel |
| Database | The provider |
| Worker, SearXNG, Ollama | The container runtime's restart policy (`restart: unless-stopped` in `deploy/research-stack.compose.yml`) with the Docker service enabled at boot — or a systemd unit each, or the platform's own supervisor |

```
docker compose -f deploy/research-stack.compose.yml --env-file .env.staging up -d
```

Without containers, the worker as a systemd unit:

```
[Service]
WorkingDirectory=/srv/manifest
EnvironmentFile=/etc/manifest/staging.env
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=5
TimeoutStopSec=40
User=manifest
```

Stopping the worker (SIGTERM) lets work in hand finish for
`WORKER_SHUTDOWN_GRACE_SECONDS`. A job cut off, or lost in a crash, is still
`running` in the table; stale recovery returns it to the queue, and a research
or SeoPulse run resumes under the same run id.

`npm run db:server`, `npm run dev` and the Windows instructions in
LOCAL_AI_SETUP.md are for development only.

### M. Backups

**NEEDED, in the database provider's console** (docs/DEPLOYMENT.md has the
checks): point-in-time restore switched on with a window the business accepts,
and one restore rehearsed into a branch. The database is the only state worth
backing up:

- Media is in the object store, which keeps its own copies; the database holds
  the references.
- The worker, SearXNG and the web application hold no state.
- Ollama's model volume is a download, not data: losing it costs a re-pull.

### N. What is still mock

| | Staging | Notes |
|---|---|---|
| Payment | `mock` | No real gateway is implemented. No money moves. |
| Shipping | `mock` | No courier is implemented. Nothing is booked. |
| SMS | none | See I. |
| Email | real once `smtp` is configured | `mock` until then. |

### Observability

Every process writes one JSON object per line (docs/OBSERVABILITY.md); the
worker writes the same events to its standard output, where the container
runtime or systemd collects them. What to look for:

| Problem | Where it shows |
|---|---|
| Failed API request | `request.failed`, `api.unexpected_error` (Vercel logs) |
| Job failed / gave up | `job.retrying`, `job.dead`; Admin → Background work |
| Queue backing up, stale jobs | health: `jobs.due`, `jobs.oldestDueMinutes`, `jobs.stale` |
| Nothing draining the queue | health: `jobs.schedulerStale`; the admin overview's warning |
| Worker down | health: `worker.state: silent`; `worker.tick_failed`, `worker.crashed` |
| Email failing | `notification.retrying`, `notification.dead`; health: `notifications.failed` |
| Ollama unreachable, timing out, model missing | the job's `lastError` and the run's failure code; health: `research` |
| SearXNG down | health: `research`; the run's notes |
| Database unreachable | health `status: down` (503); `worker.tick_failed` |

With `SENTRY_DSN` set, error-level events from the web application and the
worker go to Sentry, redacted. **NEEDED:** a Sentry project, and a log
destination for alerting; neither exists.

### What is needed to bring staging up

Accounts and resources only the owner can create:

1. A managed PostgreSQL project with a database `manifest_staging`, and its
   pooled and direct addresses.
2. A staging Vercel project (or environment) with its own variables, and a
   Blob store linked to it.
3. A machine with an NVIDIA GPU and Docker for the worker, SearXNG and Ollama.
4. A transactional email service and a verified sending domain.
5. Cloudflare DNS for the staging address.
6. Optionally a Sentry project.

## Part 2 — Validation runbook

The final production check runs on the staging deployment: the same hosting,
pooler, caching and scheduling production will have. Every step that needs the
owner's Vercel or Neon account is marked **BLOCKED** until access is given;
nothing below has been run against hosted infrastructure yet.

### Safety rules

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

### 1. Neon — BLOCKED on Neon access

1. Create a branch from the production project named `staging` (or a
   separate project).
2. In it, create `manifest_staging`, the environment's own database (Part 1,
   D). For the end-to-end run also create `preorder_e2e`, which that run drops
   and recreates, and optionally `manifest_load` for load testing with scale
   data.
3. Note both connection strings for each: the pooled one (`-pooler` host) and
   the direct one.
4. Enable `pg_stat_statements` on the branch.

### 2. Vercel — BLOCKED on Vercel access

Use a separate Vercel project (or a custom environment) for staging, so its
environment variables and cron are its own. Environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** address of `manifest_staging`. For the end-to-end run in section 4 only, of `preorder_e2e`; put it back afterwards. |
| `DATABASE_URL_UNPOOLED` | Neon **direct** address of the same database (migrations) |
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

### 3. Scheduler — BLOCKED on the hosting plan

With the worker running and `JOB_RUNNER=worker` (Part 1, F), the worker is
the scheduler and nothing in this section is needed; the check below applies
as it stands. Without a worker:

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

### 4. End-to-end suite against staging

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

### 5. Caching and serverless behaviour

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

### 6. Database connections under load

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

### 7. Performance budgets and mobile vitals

```sh
VERCEL_AUTOMATION_BYPASS_SECRET=<secret> npm run perf:budget -- --base https://<staging> \
  --paths "/,/categories/<slug>,/search?q=<word>,/products/<slug>,/cart,/login"
npm run perf:vitals -- --base https://<staging> --paths "/,/products/<slug>"
```

The vitals script drives a real browser and does not send the bypass header;
run it while Deployment Protection is off, or against a production-like
deployment without protection.

### 8. Error tracking — BLOCKED on a Sentry account

With `SENTRY_DSN` set on staging, set `JOB_SCHEDULE=not_a_job=1` for one
scheduler call: Sentry should receive one `jobs.schedule_invalid` event tagged
with a request id, and it should contain no cookie, secret or email. Remove the
variable afterwards.

### Sign-off record

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
