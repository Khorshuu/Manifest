# Staging: infrastructure and validation

How Manifest runs as a hosted staging environment that does not depend on
anybody's computer, and how that environment is checked. Written for the
engineer who sets it up and runs it, without the history behind it.

Part 1 is the infrastructure: what runs where, how it is configured, how it
is started, checked, backed up and rolled back, and what is still missing.
Part 2 is the validation runbook run against it once it exists.

**Status (2026-10-04).** The application side is built and tested
(DECISIONS.md D-132, D-133, D-134). The web tier of staging exists: Vercel's
Preview environment, with its own database, secrets and media store
(D-135). Still missing, because each needs an account, billing or DNS
decision only the owner can make: a worker host, a GPU, an email account, a
staging hostname and a Sentry project. Each is listed under **External
actions** at the end of Part 1 with the exact next step. `deploy/` holds
templates validated as far as this repository can without Docker or a GPU
(PROGRESS.md says what was run).

**Read this first — the current Vercel project (2026-10-04).**

- **Preview is staging's web tier, and is isolated from Production.**
  Production's Neon resource ("Manifest") is connected to Production only,
  and so is its deployment action: no Preview deployment receives a
  database variable from it. (Until 2026-10-03 that action gave every
  Preview deployment a Neon preview branch copied from production's data;
  migrations 0023–0045 ran on such branches, never on production's own
  database.)
- **Database.** Neon resource `manifest-staging` (Free, `sin1`), a separate
  Neon project; database `manifest_staging`, PostgreSQL 18.6, UTF8, all 46
  migrations applied, empty. Preview-only `DATABASE_URL` (pooled) and
  `DATABASE_URL_UNPOOLED` (direct) name it. They were written by hand: the
  resource's own connection (Development only, `STAGING_` prefix, not read
  by the application) names the project's default database `neondb`, not
  `manifest_staging`. **If the staging database's password is reset in
  Neon, replace both Preview variables.**
- **Secrets and media.** Preview has its own `SESSION_SECRET` and
  `CRON_SECRET` (Sensitive; replaced on 2026-10-04 and held nowhere outside
  Vercel — when the worker host is set up, replace both on Vercel and in the
  worker's env file at once) and its own Blob store (`manifest-staging`,
  Preview only). Preview-only `EXPECTED_DATABASE_NAME=manifest_staging`,
  `JOB_RUNNER=worker`, `MEDIA_BLOB_PREFIX=staging/products`: a Preview build
  stops before migrating any database that is not `manifest_staging`.
- **Address.** `manifest-git-production-readiness-manifest14.vercel.app`
  (the branch's alias), behind Deployment Protection; the project has one
  automation bypass secret for scripts.
- **No worker yet.** With `JOB_RUNNER=worker` and no worker host, nothing
  drains the queue on staging: `/api/cron/health` answers 200 `degraded`
  ("the background worker has not run jobs recently"). That is the expected
  state until External action 3.
- **Not changed, on purpose:** the Production Blob store's connection record
  (`manifest-media`) still lists Preview and Development. What a deployment
  receives is the variable entry, and Preview's only `BLOB_READ_WRITE_TOKEN`
  entry is the staging store's. Tidy the record in Vercel → Storage →
  manifest-media → Projects when convenient.

## Part 1 — Infrastructure

### 1. Architecture

```
                         shoppers and staff
                                 │
                          ┌──────▼──────┐
                          │  Cloudflare │  DNS, TLS                         PUBLIC
                          └──────┬──────┘
                          ┌──────▼──────┐
                          │   Vercel    │  Next.js: storefront, admin, APIs PUBLIC
                          └──┬───────┬──┘
              pooled address │       │ Vercel Blob (staging store)
                          ┌──▼───────▼──┐
                          │ PostgreSQL  │  managed; database manifest_staging
                          └──────▲──────┘
               direct address    │
   ┌─────────────────────────────┴─────────────────────────┐
   │ CPU host, always on — publishes no port                │
   │  ┌──────────┐  http://searxng:8080  ┌─────────┐        │
   │  │  worker  ├──────────────────────▶│ SearXNG │──▶ web search engines
   │  │ jobs,    │                       └─────────┘        │
   │  │ email,   │──▶ manufacturer pages (safeFetch, robots, Chromium)
   │  │ crawler  │──▶ SMTP service (TLS)                    │
   │  │          │──▶ Vercel: POST /api/cron/revalidate     │
   │  └────┬─────┘                                          │
   └───────┼────────────────────────────────────────────────┘
           │ private network (WireGuard / Tailscale / provider VPC)
           │ or https + bearer token through the gateway
   ┌───────▼──────────────────────────┐
   │ GPU host — may be stopped         │
   │  Ollama, qwen2.5:7b, one NVIDIA   │
   │  GPU; port bound to the private   │
   │  address only                     │
   └──────────────────────────────────┘
```

| Service | What it is | Runs on | Template |
|---|---|---|---|
| Web application | Next.js: storefront, admin, APIs | Vercel | — |
| Database | Managed PostgreSQL, one database per environment | Neon or any managed Postgres | — |
| Worker | `npm run worker`: job queue, scheduled work, email delivery, crawler, browser renderer | An always-on CPU host (2 vCPU, 4 GB is enough) | `deploy/worker.Dockerfile`, `deploy/worker-stack.compose.yml` |
| SearXNG | Web search for product research | Beside the worker, private | `deploy/worker-stack.compose.yml`, `deploy/searxng/settings.yml` |
| Ollama | The model for SeoPulse and prose extraction | A GPU host, private | `deploy/gpu-stack.compose.yml` |
| Media | Product photographs | Vercel Blob, one store per environment | — |
| Email | Transactional email over SMTP | Any transactional email service | — |
| Cloudflare | DNS and TLS in front of Vercel | Cloudflare | — |

**Why the worker is not on the GPU host** (D-134). The worker also delivers
email, expires unpaid orders, applies publish dates, prunes and sweeps. A GPU
that is stopped, restarting or switched on only for work must not stop any of
that. While Ollama is not answering, the worker leaves SeoPulse runs queued
for up to `LOCAL_AI_SERVICE_WAIT_MINUTES` (30) rather than finishing them
with the rules generator's wording; everything else runs as usual. Putting
all three on one GPU host also works (it is the same images), at the price of
that coupling.

With the owner's computer off, everything above keeps running: nothing in the
table is on it.

### 2. Public and private

| | Reachable from the internet | Protected by |
|---|---|---|
| Web application | Yes | TLS; sessions; `CRON_SECRET` on `/api/cron/*`; Vercel Deployment Protection on previews |
| Database | Only with its credentials | TLS (`sslmode=require`), the provider's password |
| Worker | **No.** It serves no HTTP and listens on nothing | — |
| SearXNG | **No** | No published port; reachable only from the worker on the compose network |
| Ollama | **No** | Port bound to the private-network address only, or the https gateway with a bearer token |
| Media | Yes, read-only (photographs are public) | Unguessable names; a write token held server-side only |

The application enforces what it can (`lib/providers/local/config.ts`): a
non-loopback Ollama or SearXNG address is refused unless
`OLLAMA_ALLOW_REMOTE` / `SEARXNG_ALLOW_REMOTE` is true, so changing the
address alone never sends a product document anywhere; a remote address must
be on a private network (a private IP, a single-label service name, a name
under `.internal` or `.local`) or use https; credentials in an address are
refused; redirects are not followed; answers are size- and time-bounded. It
cannot check a firewall. That is the operator's job.

SearXNG's rate limiter is off because its one caller is known — which is
exactly why it must never be published. Research itself is unchanged by
where SearXNG runs: English-only results, bounded counts, and every address
still fetched through `safeFetch`, checked against robots.txt, matched against
the product and proposed to a person.

### 3. Database: pooled and direct

Staging has its own database, `manifest_staging`. It is never the development
database (`preorder_utf8`), the end-to-end database (`preorder_e2e`), a
scale-test database (`manifest_scale_*`) or production's.

| Process | `DATABASE_URL` | Why |
|---|---|---|
| Web application | **Pooled** | Serverless starts many instances; a transaction pooler absorbs them (DEPLOYMENT.md). |
| Migrations (`vercel-build`) | `DATABASE_URL_UNPOOLED` = **direct** | The migration lock is a session lock. |
| Worker | **Direct** (or a session-mode pooler) | The local-AI slot is a session advisory lock held for a whole generation. |

Only Neon names its pooler (`-pooler` in the host). For any other provider,
say what each address is with **`DATABASE_CONNECTION_MODE`** = `direct`,
`session` or `transaction` (D-134): set `transaction` on the web application
if its pooled address has no `-pooler`, and `direct` on the worker once the
provider's documentation confirms it. A declaration never overrides a
`-pooler` host.

The worker does not take an address's word for it. At start, with local AI
configured, it holds one connection, takes an advisory lock, checks that a
second connection is refused it and that the release comes from the same
session (`db/session-probe.ts`). A failure proves a transaction pooler and
the worker refuses to start. A pass is evidence, not proof — an idle pooler
can pass — so an undeclared address passes with a warning.

**`EXPECTED_DATABASE_NAME=manifest_staging`** on the web application and the
worker makes migrations and the worker ask `current_database()` before
writing anything, and stop when it is another database.

### 4. Migrations

`vercel-build` runs `tsx db/migrate.ts && next build`: every deployment
applies pending migrations through `DATABASE_URL_UNPOOLED` before building,
each file once, in a transaction, recorded with its checksum in
`schema_migrations`. The latest is `0045_notification_retry_backoff.sql`.

First time, or by hand, from any machine with the direct address:

```
npm run staging:check -- --role web --env-file .env.staging.web   # read only: identity, TLS, ledger, lock
DATABASE_URL=<direct address> DATABASE_URL_UNPOOLED= \
EXPECTED_DATABASE_NAME=manifest_staging npm run db:migrate:deploy
npm run staging:check -- --role web --env-file .env.staging.web   # "Up to date: 46 applied, latest 0045_…"
```

Never replay SQL files by hand, never run `npm run db:setup` or `db:seed`
against staging (they seed and truncate), and never seed customers or
orders there.

### 5. Environment variables

Values live only in the hosts' own settings: Vercel's for the web
application (Preview, or a custom `staging` environment — never
Production), the worker host's `.env.staging` for the worker (never
committed; `.gitignore` covers `.env*`), the GPU host's `.env.gpu`. Nothing
secret goes in Git, `.env.example`, this document or a test. `.env.example`
lists every name.

| Variable | Web (Vercel Preview/staging) | Worker | Purpose | Secret | Connection |
|---|---|---|---|---|---|
| `DATABASE_URL` | yes | yes | Database | yes | web: **pooled**; worker: **direct** |
| `DATABASE_URL_UNPOOLED` | yes | — | Migrations at build | yes | **direct** |
| `DATABASE_CONNECTION_MODE` | `transaction` unless Neon | `direct` / `session` | What `DATABASE_URL` is | no | — |
| `EXPECTED_DATABASE_NAME` | `manifest_staging` | `manifest_staging` | Refuse another database | no | — |
| `SESSION_SECRET` | yes | same value | Session signing, 32+ chars | yes | — |
| `CRON_SECRET` | yes | same value | `/api/cron/*`, revalidation | yes | — |
| `SITE_URL` | staging address | same | Canonical links; worker's revalidation target | no | https |
| `WORKER_WEB_URL` | — | optional | Revalidation target if not `SITE_URL` | no | https |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | — | if Deployment Protection is on | Worker → protected deployment | yes | — |
| `JOB_RUNNER` | `worker` | `worker` | Web trigger declines; worker runs the queue | no | — |
| `WORKER_ALIVE_FILE` | — | set by the image | Container liveness | no | — |
| `MEDIA_PROVIDER` | `blob` | `blob` | Media store | no | — |
| `BLOB_READ_WRITE_TOKEN` | staging store's | same | Media writes and sweep | yes | — |
| `MEDIA_BLOB_PREFIX` | `staging/products` if the store is shared | same | Folder this environment owns | no | — |
| `NOTIFICATION_PROVIDER` | `smtp` | `smtp` | Real email | no | — |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | yes | same | Email service endpoint | no | TLS required |
| `SMTP_USER`, `SMTP_PASSWORD` | yes | same | Email service login | yes | — |
| `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO` | yes | same | Sender on a verified domain | no | — |
| `NOTIFICATION_RECIPIENT_ALLOWLIST` | testers | same | Staging writes only to these | no (but personal data) | — |
| `PRODUCT_RESEARCH_PROVIDER` | `local` | `local` | Research discovery | no | — |
| `PRODUCT_EXTRACTION_PROVIDER` | `ollama` | `ollama` | Prose extraction | no | — |
| `SEO_PULSE_AI_PROVIDER`, `OLLAMA_MODEL` | `ollama`, `qwen2.5:7b` | same | SeoPulse model | no | — |
| `OLLAMA_BASE_URL`, `OLLAMA_ALLOW_REMOTE` | **unset** | GPU's private address (or gateway https), `true` | Model service | no | private http or https |
| `OLLAMA_AUTH_TOKEN` | — | only with the gateway | Gateway bearer token | yes | https only |
| `SEARXNG_BASE_URL`, `SEARXNG_ALLOW_REMOTE` | **unset** | `http://searxng:8080`, `true` (compose sets them) | Search service | no | private |
| `SEARXNG_SECRET` | — | worker host's env file (compose) | SearXNG's own key | yes | — |
| `LOCAL_BROWSER_RENDERER` | — | `playwright` | JavaScript-only pages | no | — |
| `LOCAL_AI_CONCURRENCY` | — | `1` | Generations at once | no | — |
| `LOCAL_AI_SERVICE_WAIT_MINUTES` | — | `30` | How long AI jobs wait for a GPU | no | — |
| `PAYMENT_PROVIDER`, `SHIPPING_PROVIDER` | `mock` | `mock` | **Mock** | no | — |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT=staging` | optional | same | Error tracking | DSN: low | https |

The provider names are set on the web application too because it decides,
when staff start a run, whether the run must be queued. It never calls
Ollama or SearXNG, so it gets none of their addresses.

### 6. Worker deployment

Build from the repository root and run on the CPU host:

```
docker compose -f deploy/worker-stack.compose.yml --env-file .env.staging up -d --build
docker compose -f deploy/worker-stack.compose.yml exec worker \
  node node_modules/tsx/dist/cli.mjs scripts/jobs/worker.ts --check
```

The image (`deploy/worker.Dockerfile`): Node 22, `npm ci` from the lockfile,
Chromium with its libraries for the renderer, tini as PID 1, runs as `node`,
no secret and no `.env` file inside (`.dockerignore`). The start command is
`npm run worker` in effect (`node node_modules/tsx/dist/cli.mjs
scripts/jobs/worker.ts`). Without containers: `npm ci --include=dev`,
`npx playwright-core install --with-deps chromium`, `npm run worker` under
systemd:

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

What it does: every 15 s (`WORKER_INTERVAL_SECONDS`) a tick schedules
recurring work, recovers stale jobs, claims due jobs with
`FOR UPDATE SKIP LOCKED`, runs them with heartbeats, retries with backoff and
records the scheduler heartbeat; up to 3 ticks overlap
(`WORKER_MAX_CONCURRENT_TICKS`) so a slow research job never holds up email.
One local-AI job at a time runs in its own lane holding the local-AI slot.
About once a minute it records what it can reach (SearXNG, Ollama and the
model, the renderer) for the health report. A second worker is safe; one is
enough.

`npm run worker -- --check` prints the full health report plus its own
startup checks (database identity, mode, session lock) and exits 1 on a
problem. `-- --once` runs one tick.

### 7. Health and liveness

| Check | Who | What it tells |
|---|---|---|
| `GET /` | Anyone; point uptime monitors here | The web application is serving |
| `GET /api/cron/health` + `Authorization: Bearer <CRON_SECRET>` | A monitor | The report below as JSON; 503 only when the database is unreachable |
| `GET /api/admin/health` | Signed-in staff | The same report |
| Admin → Background work / Notifications | Staff | Each job kind's last run, dead jobs (retry), the outbox |
| `npm run worker -- --check` | On the worker | The report from where the private services are reachable |
| Container `HEALTHCHECK` (`scripts/jobs/worker-alive.mjs`) | Docker | The worker's loop is turning (liveness only; no database, no network) |

The report: database (reachable, latency, pooled, connection mode), the job
queue (queued, due, oldest due, running, stale, dead, local-AI jobs
waiting), whoever drains it (late or not), the worker (reporting or silent),
the email provider (logs in, sends nothing) and outbox (queued, sending,
retrying, failed for good), SearXNG, Ollama and its model, the renderer, the
local-AI lock connection (`direct`, `pooled`, `unverified`), and the media,
payment and shipping providers by name. `status` is `ok`, `degraded` (with
`problems` in sentences) or `down`. It never carries an address, host name,
key, token, password, recipient, prompt or customer data
(`tests/worker.test.ts`, `tests/staging-readiness.test.ts`).

### 8. Media

Vercel Blob is the implemented store (`MEDIA_PROVIDER=blob`); R2 has no
provider. Staging gets its **own Blob store**, linked to the staging
environment only, so its token cannot reach production's files. Where a
store must be shared, `MEDIA_BLOB_PREFIX=staging/products` keeps staging in a
folder of its own: the provider claims, reads, sweeps and deletes only keys
under its prefix (D-134). The token is read only by server code (the media
provider); it is never sent to a browser or written to a log. The end-to-end
suite and unit tests use `MEDIA_PROVIDER=local` and never touch Blob.
Uploads are validated, decoded and re-encoded as WebP under generated names;
only Admin and Staff can upload (enforced in the API).

### 9. Email

One adapter, SMTP (`NOTIFICATION_PROVIDER=smtp`), behind the provider
boundary and the durable outbox (D-132):

- A message is written to the outbox in the same transaction as its cause,
  with a dedupe key.
- Delivery claims each row before sending, so two drains never send one
  message twice.
- TLS is required (STARTTLS on 587, TLS on 465); a server that does not offer
  it gets nothing.
- A temporary failure is retried after 1, 2, 4, 8, 16, 32 and 60 minutes —
  eight attempts over about two hours — then the row is `failed` for good,
  counted in health and shown on Admin → Notifications.
- A permanent failure (no such mailbox; a recipient outside the allow-list;
  an invalid address) stops at once.
- Every attempt at one message carries the same `Message-ID`
  (`<idempotency-key@sender-domain>`). SMTP has no idempotency key: a crash
  between the provider accepting and the row being marked sent can deliver
  twice, with the same Message-ID.
- Errors are recorded by kind; no password, user, host or recipient reaches a
  log.

**Staging allow-list.** `NOTIFICATION_RECIPIENT_ALLOWLIST` (whole addresses,
or `@domain`) is mandatory on staging: a test order placed with a real
customer's address is refused, permanently, before any connection.
`npm run staging:check` reports it MISSING when unset.

**SMS** is modelled in the outbox and has no provider: an SMS row fails with
"No SMS provider is configured".

### 10. SearXNG

`deploy/worker-stack.compose.yml` runs `searxng/searxng` beside the worker
with `deploy/searxng/settings.yml`: JSON output on, English by default, no
metrics, no image proxy, limiter off, no published port, 512 MB and one CPU,
a `/healthz` health check. `SEARXNG_SECRET` comes from the env file. The
settings file was loaded by a real SearXNG (2026-09 source build) here and
answered an English JSON search (PROGRESS.md); the container itself has not
been run here (no Docker).

### 11. Ollama and the GPU

- **Machine:** one NVIDIA GPU, driver plus NVIDIA Container Toolkit. 24 GB of
  video memory is the recommended class for headroom; `qwen2.5:7b` needs
  about 6 GB and fits 12–16 GB. The application does not know which card.
- **Template:** `deploy/gpu-stack.compose.yml` — Ollama with a model volume,
  `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `ollama list`
  health check, and a one-shot `ollama pull qwen2.5:7b`.
- **Reaching it:** bind its port to the GPU host's private-network address
  (`OLLAMA_BIND_ADDRESS`, required — never `0.0.0.0`) and set on the worker
  `OLLAMA_BASE_URL=http://<that address>:11434`, `OLLAMA_ALLOW_REMOTE=true`.
  Only when no private network is possible: `--profile gateway` adds Caddy
  (`deploy/ollama/Caddyfile`) serving https on `OLLAMA_GATEWAY_DOMAIN`,
  answering only `/api/tags` and `/api/chat`, only with
  `Authorization: Bearer <OLLAMA_AUTH_TOKEN>` (32+ letters and digits), and
  refusing everything when the token is missing; then bind Ollama to
  `127.0.0.1`.
- **Concurrency:** `LOCAL_AI_CONCURRENCY=1`. Raise only after benchmarking
  that card with two generations at once.
- **Timeout:** `OLLAMA_TIMEOUT_MS` (240000). Stale windows and heartbeats are
  derived from it.

**When the GPU is down.** Nothing a shopper touches calls Ollama: storefront,
search, accounts and orders do not depend on it. Email and scheduled jobs run
on the CPU worker. AI work records why it could not have the model, with
D-127's codes (`OLLAMA_UNAVAILABLE`, `OLLAMA_MODEL_NOT_FOUND`,
`OLLAMA_GENERATION_TIMEOUT`, `OLLAMA_QUEUE_WAIT_TIMEOUT`, …):

- A SeoPulse run waits queued for up to `LOCAL_AI_SERVICE_WAIT_MINUTES`;
  then it finishes with the rules generator's wording, recorded as **rules**
  with `fallbackFrom` naming the outage — never as the model's.
- Prose extraction in a research job reports that the page's sentences were
  not read; the structured readers' findings stand.
- A document staff paste or upload is read by the structured readers only
  when the worker runs the jobs: the web application cannot reach a private
  model (D-134). Moving that reading into a job is follow-up.
- A preparation run that writes with SeoPulse inside its own job does not
  wait for the GPU; its SeoPulse step falls back like any other.

A partial or malformed answer is never kept.

### 12. Cache revalidation

The worker's jobs change what shoppers see (a publish date, a prepared
listing), but the worker has no cache of its own. It collects the cache tags
its jobs invalidate and, after each tick, posts them to
`POST <SITE_URL>/api/cron/revalidate` with `Authorization: Bearer
<CRON_SECRET>` (and `x-vercel-protection-bypass` when set). The route accepts
only the application's own tag names (500 at most) and only that secret
(constant-time comparison); invalidation is idempotent. A failed post is
logged as `worker.cache_forward_failed` and its tags are kept for the next
tick (bounded). Without `SITE_URL`/`WORKER_WEB_URL`, pages catch up when
their cache lifetime lapses (minutes).

### 13. Observability

Every process writes one JSON object per line (OBSERVABILITY.md); the worker
to its standard output, where Docker or systemd keeps it.

| Problem | Where it shows |
|---|---|
| Worker started / stopping / stopped / crashed | `worker.started` (database name, mode, lock verdict), `worker.stopping`, `worker.stopped`, `worker.crashed` |
| Worker refused to start | `worker.refused_to_start` (wrong database, pooled address, lock test failed) |
| Job failed / gave up | `job.retrying`, `job.dead`; Admin → Background work |
| Queue backing up, stale jobs | health `jobs.due`, `jobs.oldestDueMinutes`, `jobs.stale` |
| Nothing draining the queue | health `jobs.schedulerStale`; `worker.state: silent` |
| Email failing | `notification.retrying`, `notification.dead`; health `notifications` |
| Ollama down / model missing | `worker.local_ai_waiting`, `worker.local_ai_available`; the run's `fallbackFrom`; health `research` |
| SearXNG down | health `research`; the run's notes |
| Database unreachable | health `status: down` (503); `worker.tick_failed` |
| Revalidation failing | `worker.cache_forward_failed` |

**Sentry is optional.** With `SENTRY_DSN` set, error-level events from the web
application and the worker go to Sentry, redacted; without it, error
tracking is off and says so (`worker.started` → `errorTracking`). No Sentry
project exists. Part 2, section 8 is the check once one does.

### 14. Startup, restart, rollback

Nobody types a start command after a reboot:

| Service | Started and restarted by |
|---|---|
| Web application | Vercel |
| Database | The provider |
| Worker, SearXNG | Docker's `restart: unless-stopped` with the Docker service enabled at boot (or systemd `Restart=always`) |
| Ollama | The same, on the GPU host |

SIGTERM lets work in hand finish for `WORKER_SHUTDOWN_GRACE_SECONDS` (25);
give the container 40 s. A job cut off, or lost in a crash, stays `running`;
stale recovery returns it to the queue and research or SeoPulse resumes under
the same run id.

**Rollback.** Web: redeploy the previous commit's deployment (Vercel →
Deployments → the previous one → Redeploy). Migrations are written to be
additive, so the previous code normally runs on the newer schema; if one is
not, restore (section 15). Worker: `docker compose … up -d` with the previous
image (tag images by commit). A migration is never reverted by hand.

### 15. Backups and restore

The database is the only state worth backing up. Media is in the object
store; the worker, SearXNG and the web application hold none; Ollama's model
volume is a download.

**To confirm in the provider's console (External action 2):** automatic
backups on; point-in-time restore window (Neon: the project's history
retention, by plan); how long backups are kept.

**Restore drill** (once, then after major changes):

1. In the provider, create a branch (Neon) or a restore copy from a
   timestamp an hour ago, named `manifest_staging_restore_drill`.
2. `npm run staging:check -- --role worker --env-file .env.restore
   --expect-database <its name>` (an env file whose `DATABASE_URL` is the
   copy's direct address): it must reach the copy, find the ledger up to
   date, and hold a session lock.
3. Compare row counts of `orders`, `products`, `notifications`, `jobs` with
   the live database at that timestamp.
4. Delete the branch. Record the date, duration and result in Part 2's
   sign-off table.

### 16. Secrets

| Secret | Lives in | Rotated by |
|---|---|---|
| Database passwords | Provider; Vercel env; worker env file | Provider console, then both hosts |
| `SESSION_SECRET` | Vercel env; worker env file | Replace (signs everyone out) |
| `CRON_SECRET` | Vercel env; worker env file | Replace on both at once |
| `BLOB_READ_WRITE_TOKEN` | Vercel (linked store); worker env file | Vercel Blob settings |
| `SMTP_PASSWORD` | Vercel env; worker env file | Email service |
| `OLLAMA_AUTH_TOKEN`, `SEARXNG_SECRET` | Worker env file; GPU env file | Replace on both |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Vercel; worker env file | Vercel project settings |

Every staging secret differs from production's. None is in Git, an image
layer, a log or the health report.

### 17. Staging verification

```
npm run staging:check -- --role web --env-file .env.staging.web
npm run staging:check -- --role worker --env-file .env.staging
docker compose -f deploy/worker-stack.compose.yml exec worker \
  node node_modules/tsx/dist/cli.mjs scripts/jobs/worker.ts --check
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<staging>/api/cron/health
```

`staging:check` reads one role's settings (`.env.staging.web` from
`vercel env pull --environment=preview .env.staging.web`, deleted after) and
reports READY / WARNING / MISSING for: database pooled, database direct,
database identity, secrets, worker mode, media, SMTP and allow-list,
SearXNG, Ollama, the renderer, Search Console, Sentry, payment mock and
shipping mock. Then, unless `--offline`, it checks — reading only — which
database each address reaches, TLS, the migration ledger, a session lock,
the SMTP login (nothing sent), one SearXNG query and Ollama's model list. It
prints no value and exits 1 when anything is MISSING. Then run Part 2.

### 18. Known limitations

- A document staff provide is not read by a private model (section 11).
- A "serverless GPU" whose API is not Ollama's needs its own provider.
- R2 has no media provider; SMS has no provider; account and security email
  (password reset, sign-in alerts) is not written.
- The session-lock test cannot prove an address is direct.
- Vercel Cron runs only on Production; with the worker it is not needed.
- `/api/cron/maintenance` still runs in the web application with
  `JOB_RUNNER=worker` (daily on Vercel); its work needs no private service and
  every step is idempotent, so it overlaps the worker safely.

### 19. Payment and shipping

**Mock, in staging and everywhere.** No payment gateway and no courier is
implemented; no money moves and nothing is booked. `staging:check` reports
anything but `mock` as MISSING.

### External actions

Only things that need an account, billing, DNS or a console. Code, templates
and checks for each are in place.

1. **Take Preview off production's Neon connection.** DONE 2026-10-04 (the
   owner, in the Vercel dashboard): the "Manifest" resource and its
   deployment action are Production only. Preview-only `DATABASE_URL`
   (pooled) and `DATABASE_URL_UNPOOLED` (direct) for `manifest_staging` were
   then added and Preview redeployed.
2. **Managed staging database.** DONE 2026-10-03: Neon resource
   `manifest-staging`, database `manifest_staging`.
   Left: confirm in the Neon console (Settings → Storage / History
   retention) the point-in-time window; no API key is available here.
   For the worker: `.env.staging` `DATABASE_URL` (direct) with
   `DATABASE_CONNECTION_MODE=direct`. Then section 4.
3. **Worker host.**
   Missing: an always-on Linux host with Docker (2 vCPU, 4 GB).
   Why not automatic: a paid resource.
   Next: create it, install Docker, clone the repository, write
   `.env.staging` (section 5), `docker compose -f
   deploy/worker-stack.compose.yml --env-file .env.staging up -d --build`.
   Where: the host; `.env.staging` beside the checkout, mode 600.
4. **Staging Blob store.** DONE 2026-10-03: Blob store `manifest-staging`,
   connected to Preview only.
   For the worker: copy Preview's `BLOB_READ_WRITE_TOKEN` to its
   `.env.staging`.
5. **Email.**
   Missing: a transactional email account, a verified sending domain (SPF,
   DKIM in Cloudflare DNS), SMTP host, port, user and password.
   Why not automatic: account, domain ownership and DNS.
   Where: Vercel Preview and `.env.staging`: `NOTIFICATION_PROVIDER=smtp`,
   `SMTP_*`, `EMAIL_FROM`, `NOTIFICATION_RECIPIENT_ALLOWLIST=<testers>`.
6. **GPU host.**
   Missing: an NVIDIA GPU host (24 GB class) with Docker and the NVIDIA
   Container Toolkit, and a private network to the worker host.
   Why not automatic: a paid resource.
   Next: `docker compose -f deploy/gpu-stack.compose.yml --env-file .env.gpu
   up -d` with `OLLAMA_BIND_ADDRESS=<private address>`; on the worker
   `OLLAMA_BASE_URL=http://<private address>:11434`, `OLLAMA_ALLOW_REMOTE=true`.
7. **DNS.** A staging hostname in Cloudflare pointing at Vercel; set
   `SITE_URL`.
8. **Sentry (optional).** A project's DSN in `SENTRY_DSN`,
   `SENTRY_ENVIRONMENT=staging`, on Vercel Preview and the worker.

## Part 2 — Validation runbook

The final production check runs on the staging deployment: the same hosting,
pooler, caching and scheduling production will have. Every step that needs the
owner's Vercel or Neon account is marked **BLOCKED** until access is given.
Of the steps below, only a smoke test has been run against the hosted
Preview (PROGRESS.md, 2026-10-04); the end-to-end suite, load test and
sign-off have not.

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

### 1. Neon — `manifest_staging` exists; the rest BLOCKED on the Neon console

`manifest_staging` is in place (Part 1, "Read this first"), so step 2's
first sentence and step 3 are done for it. The scratch databases and
`pg_stat_statements` are not.

1. Create a branch from the production project named `staging` (or a
   separate project).
2. In it, create `manifest_staging`, the environment's own database (Part 1,
   section 3). For the end-to-end run also create `preorder_e2e`, which that run drops
   and recreates, and optionally `manifest_load` for load testing with scale
   data.
3. Note both connection strings for each: the pooled one (`-pooler` host) and
   the direct one.
4. Enable `pg_stat_statements` on the branch.

### 2. Vercel — Preview is staging (database, secrets, Blob set)

Staging is the project's Preview environment, whose variables are its own
(Part 1, "Read this first"). The first five rows below and the Blob store
are set; `SITE_URL` waits for a staging hostname and Sentry for an account.
Environment variables:

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

With the worker running and `JOB_RUNNER=worker` (Part 1, section 6), the worker is
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
