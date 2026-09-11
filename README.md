# Manifest

A preorder storefront and admin for a shop that sources products in the United
States and delivers them in Bangladesh at a fixed landed price.

One Next.js application serves three surfaces from one codebase: the public
storefront, the customer account area, and the staff admin. The architecture,
database, business rules, security model and decision log live in [`docs/`](docs).

## Requirements

- Node.js 20 or newer
- A PostgreSQL database (local, or hosted — Neon, Supabase, RDS…)

## Running it locally

```bash
npm install
cp .env.example .env.local          # then fill in SESSION_SECRET
npm run db:server                   # optional: a local PostgreSQL on 127.0.0.1:5432
npm run db:setup                    # applies every migration and seeds demo data
npm run dev                         # http://localhost:3000
```

`npm run db:setup` seeds three demo accounts, all with the password
`password123`: `admin@example.com` (owner), `staff@example.com` (operations),
`customer@example.com`. **Seed data is for development only — never run it
against production.**

### Checks

```bash
npm run typecheck
npm run lint
npm test            # unit and integration tests (in-process PostgreSQL)
npm run test:e2e    # browser tests (Playwright); uses its own database
```

## Deploying to Vercel

1. **Create a PostgreSQL database** and copy its connection string. Neon works
   well with Vercel; any Postgres does.
2. **Import this repository** in Vercel. Framework preset: Next.js. The build
   command (`next build`) and output are detected automatically.
3. **Set the environment variables** below in Vercel → Settings → Environment
   Variables, for Production (and Preview, if you use it).
4. **Apply the migrations** to the hosted database once, from your machine:

   ```bash
   DATABASE_URL="<hosted connection string>" npm run db:setup
   ```

   `db/setup.ts` applies every file in `db/migrations` in order and is safe to
   re-run; it also seeds demo data, so for a real shop apply the migrations
   only — comment out the seed step or run against an empty database you then
   clear.
5. **Deploy.** The cron entry in `vercel.json` calls `/api/cron/maintenance`
   every ten minutes; Vercel sends `CRON_SECRET` as a bearer token
   automatically, and the endpoint refuses every request when that variable is
   not set.

### Environment variables

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string (`postgres://…`). |
| `SESSION_SECRET` | yes | 32+ random characters; signs session cookies. |
| `CRON_SECRET` | yes on Vercel | Shared secret for the scheduled sweep. |
| `SITE_URL` | recommended | Public origin, e.g. `https://example.com`; used in canonical URLs, the sitemap and structured data. |
| `DATABASE_POOL_MAX` | no | Connection pool size (default 10; use a small number on serverless). |
| `PAYMENT_PROVIDER` | no | `mock` (default) or `sslcommerz` (not implemented yet). |
| `SHIPPING_PROVIDER` | no | `mock` (default) or `courier`. |
| `NOTIFICATION_PROVIDER` | no | `mock` (default) or `live`. |
| `LOGIN_RATE_LIMIT_PER_ACCOUNT` / `LOGIN_RATE_LIMIT_PER_IP` | no | Login attempt ceilings per 15 minutes. |
| `SEO_PULSE_AI_PROVIDER` | no | `rules` (default, free) or `anthropic`. |
| `ANTHROPIC_API_KEY` | only with `anthropic` | Paid per run. |
| `SEO_PULSE_DATA_PROVIDER` | no | `none` (default) or `dataforseo`. |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | only with `dataforseo` | Paid per request. |

Never commit any of these: `.env*` is ignored, and `.env.example` carries the
names only.

### Known limitation on serverless hosting

Product photographs are written to a directory on disk by the local media
provider (`lib/providers/media/`). Vercel's filesystem is read-only and
per-request, so **uploading a photograph will fail in a Vercel deployment**
until an object-storage provider (Cloudflare R2, S3…) is implemented behind
the existing `MediaProvider` interface — the call sites do not change. Images
already committed under `public/` are served normally.

Everything else runs on Vercel as is: payments, shipping and notifications use
their mock providers until real credentials are configured, and no flow
depends on a persistent local disk.
