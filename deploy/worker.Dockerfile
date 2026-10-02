# The background worker (docs/STAGING.md, DECISIONS.md D-133).
#
# One image for the process that runs the job queue outside the web
# application: scheduled work, message delivery, product research (crawler and
# browser renderer) and the calls to SearXNG and Ollama. It serves no HTTP and
# publishes no port.
#
#   docker build -f deploy/worker.Dockerfile -t manifest-worker .
#
# Every setting comes from the environment at run time. Nothing secret is
# copied in: .dockerignore keeps every .env file out of the build context.

FROM node:22-bookworm-slim

ENV NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# tsx runs the worker and is a development dependency, so those are installed.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Chromium and the system libraries it needs, for LOCAL_BROWSER_RENDERER=playwright.
# The version is the one playwright-core in package.json expects.
RUN npx playwright-core install --with-deps chromium \
    && chmod -R a+rx /ms-playwright

COPY . .

# Not root: the renderer starts a browser on pages from the internet.
USER node

# SIGTERM lets work in hand finish (WORKER_SHUTDOWN_GRACE_SECONDS); give the
# container at least that long to stop.
STOPSIGNAL SIGTERM
CMD ["node", "node_modules/tsx/dist/cli.mjs", "scripts/jobs/worker.ts"]
