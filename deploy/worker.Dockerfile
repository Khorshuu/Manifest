# The background worker (docs/STAGING.md, DECISIONS.md D-133, D-134).
#
# One image for the process that runs the job queue outside the web
# application: scheduled work, message delivery, product research (crawler and
# browser renderer) and the calls to SearXNG and Ollama. It serves no HTTP and
# publishes no port. Built from the repository root:
#
#   docker build -f deploy/worker.Dockerfile -t manifest-worker .
#   docker run --rm --env-file .env.staging manifest-worker \
#     node node_modules/tsx/dist/cli.mjs scripts/jobs/worker.ts --check
#
# Every setting comes from the environment at run time. Nothing secret is
# copied in: .dockerignore keeps every .env file, .git and local data out of
# the build context, and no build argument carries a value.

FROM node:22-bookworm-slim

# WORKER_ALIVE_FILE is touched on every pass of the worker's loop and read by
# the HEALTHCHECK below.
ENV NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    WORKER_ALIVE_FILE=/tmp/manifest-worker-alive

WORKDIR /app

# Tini as PID 1: forwards SIGTERM to the worker and reaps the browser's child
# processes, which Node as PID 1 would leave as zombies.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Exactly the lockfile. tsx runs the worker and is a development dependency,
# so those are installed too.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# Chromium and the system libraries it needs, for LOCAL_BROWSER_RENDERER=playwright.
# The version is the one playwright-core in package.json expects.
RUN npx playwright-core install --with-deps chromium \
    && chmod -R a+rx /ms-playwright

COPY . .

# Not root: the renderer starts a browser on pages from the internet.
USER node

# Liveness only: the loop is turning. Asks nothing of the database or the
# network (scripts/jobs/worker-alive.mjs); `--check` is the full report.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "scripts/jobs/worker-alive.mjs"]

# SIGTERM lets work in hand finish (WORKER_SHUTDOWN_GRACE_SECONDS, 25 s); give
# the container at least 40 s to stop. Restarting is the platform's job.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "scripts/jobs/worker.ts"]
