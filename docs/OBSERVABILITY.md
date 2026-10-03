# Observability

What the application records about itself in production, and how to use it
to diagnose a problem. Written for whoever operates the site.

## Log format

Every event is one JSON object per line on standard output (`info`) or
standard error (`warn`, `error`), written by `lib/observability/log.ts`:

```json
{"ts":"2026-09-17T10:03:33.489Z","level":"info","event":"checkout.place","requestId":"eaebead5-990e-4d56-a59a-ad796eb05e16","method":"card","signedIn":false,"outcome":"ok","durationMs":251,"orderNumber":"ORD-2026-000015","paymentStatus":"initiated"}
```

On Vercel these appear in the function logs and can be sent anywhere through a
log drain; filter on `event`, `level`, `outcome` or `requestId`.

## Request ids

`proxy.ts` gives every request an id (keeping Vercel's own `x-vercel-id` when
present) and returns it in the `x-request-id` response header. Every log line
written while handling that request carries it. When a shopper or staff member
reports a failure, the id from the response (browser network tab) finds every
line for that request.

## Events

| Event | Level | When | Fields |
|---|---|---|---|
| `checkout.place` | info / warn / error | Every order placement | `method`, `signedIn`, `outcome`, `durationMs`, `orderNumber`, `paymentStatus`; on failure the error name and message |
| `payments.start_failed` | error | The provider could not start a payment after the order was saved | `orderNumber`, error |
| `payments.webhook` | info / warn / error | Every payment webhook | `provider`, `bytes`, `outcome`, `result` (processed, ignored, duplicate), `durationMs` |
| `jobs.trigger` | info | Each scheduler call to `/api/cron/jobs` | `scheduled`, `recovered`, `succeeded`, `retried`, `dead`, `disabled` |
| `jobs.schedule_invalid` | error | `JOB_SCHEDULE` has an entry that was ignored | `problems` |
| `job.succeeded` | info | A background job finished | `jobId`, `kind`, `attempt`, `durationMs` |
| `job.retrying` / `job.dead` | warn / error | A job failed and will retry / gave up | as above, plus `maxAttempts` and the error |
| `search.slow` | warn | A listing or search took 500 ms or more | `durationMs`, `hasQuery`, `filtered`, `scoped`, `total`, `page` |
| `request.failed` | error | Any unhandled error in rendering, a route handler or the proxy (`instrumentation.ts`) | `method`, `path` (no query string), `routePath`, `routeType`, `digest`, error |
| `api.unexpected_error` | error | A route handler caught an error it could not classify (answered 500) | error |
| `api.database_conflict` | warn | A known database conflict answered as 409/503 | `code`, `status` |
| `rate_limit.check_failed` | error | The rate-limit table could not be read (the attempt is allowed) | error |
| `notification.retrying` / `notification.dead` | warn / error | A message could not be delivered and will be tried again / will not | `notificationId`, `channel`, `provider`, `attempt`, `maxAttempts`, `permanent`, `reason` (never the recipient) |
| `jobs.local_ai` / `jobs.local_ai_failed` | info / error | The local-AI lane ran a job / could not start | `ran`, or the error |
| `worker.started` / `worker.stopping` / `worker.stopped` | info | The background worker's lifecycle (D-133) | interval, providers in use, ticks run |
| `worker.tick_failed` | error | One worker tick threw, usually the database being unreachable; the next tick tries again | `tickId`, error |
| `worker.tick_skipped` | warn | Every tick was still busy when the next was due | `running` |
| `worker.refused_to_start` / `worker.crashed` | error | The worker would not start (another database than EXPECTED_DATABASE_NAME, a pooled address with local AI on, a failed session-lock test; D-134) / exited on an error | reason or error |
| `worker.database_note` | warn | The worker's address passed the session-lock test but its mode is not declared (D-134) | `note` |
| `worker.local_ai_waiting` / `worker.local_ai_available` | warn / info | Ollama stopped answering (or lacks the model), so local-AI jobs wait; and when it is back. Logged on the change only (D-134) | `state`, `waitMinutes` |
| `pkb.extraction_not_in_web_request` | info | A provided document was read without the private local model, because a worker runs the jobs (D-134) | `reason` |
| `worker.cache_forward_failed` / `worker.cache_forward_off` | warn | Cache tags could not be handed to the web application / are not configured to be | `status`, `tags` |
| `health.check_failed` | error | The health report itself threw | error |
| `search.log_failed` and neighbours | warn | Best-effort analytics could not be written | error |

A known refusal (an error with a status below 500 — the preorder is full, the
cart is empty) is logged as `warn`, so `error` means something is actually
broken.

## What is never logged

`redact` runs on every entry before it is written:

- Any field whose name looks like a password, secret, token, authorization,
  cookie, signature, one-time code, recovery code, card or session is replaced
  with `[redacted]`, at any depth.
- Email addresses in text become `n***@example.com`; Bangladeshi mobile numbers
  and other international numbers keep only their last three digits.
- Request query strings are dropped from `request.failed` (a lookup URL can
  carry an email address). Request and response bodies are never logged.

`tests/observability.test.ts` covers the redaction rules.

## Diagnosing a checkout problem

1. Get the request id from the failing response's `x-request-id`, or find
   `checkout.place` lines with `"outcome":"failed"` around the reported time.
2. The same request id shows any `api.database_conflict`, `payments.start_failed`
   or `request.failed` line from that request.
3. The order number on a successful `checkout.place` links the log to the
   order in the admin, where its status history and payment rows are kept.

## Health

`GET /api/admin/health` (staff) and `GET /api/cron/health` (with
`Authorization: Bearer <CRON_SECRET>`) return one report: the database, the
job queue and whoever drains it, the worker, the notification provider and
outbox, SearXNG, Ollama and its model, and the providers in use. `status` is
`ok`, `degraded` or `down`, with `problems` in sentences; the monitor's route
answers 503 only when the database is unreachable. States and counts only: no
address, key or customer data. `npm run worker -- --check` prints the same
from the worker. docs/STAGING.md, section 13, lists what to watch.

The background worker writes the same JSON lines to its standard output as
the web application; whatever runs it (a container runtime, systemd) collects
them.

## Not in place

- **Error tracking in Sentry is prepared but not connected.** With
  `SENTRY_DSN` set, `instrumentation.ts` starts the Sentry SDK on the server
  and every `error`-level event above is also sent to Sentry, tagged with its
  event name and request id (`lib/observability/error-reporting.ts`). Before
  anything is sent, the log redaction runs on the fields and a second pass
  removes the user, cookies, request bodies, query strings and every header
  except user agent, content type and request id, and masks emails and phone
  numbers in error messages. Personal data, local variables and performance
  tracing are off (`SENTRY_TRACES_SAMPLE_RATE` turns tracing on). Verified
  against a local stand-in for Sentry's ingest, from the production build: an
  invalid `JOB_SCHEDULE` produced one event with its request id, no scheduler
  secret and no cookie (`tests/error-reporting.test.ts` does the same in the
  unit suite). BLOCKED on the owner's Sentry account: delivery to a real
  project, alert rules, and source-map upload (needs `SENTRY_AUTH_TOKEN` and
  the build plugin). Browser errors are not captured: the browser SDK would
  push pages past the JavaScript budget.
- **Database statement timing.** Individual query timings are not logged; use
  `pg_stat_statements` in Neon (docs/DEPLOYMENT.md).
- **Alerting** on `level=error` or on `job.dead` needs a log drain destination.
