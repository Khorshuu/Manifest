import type { Instrumentation } from "next";

/**
 * Error tracking (lib/observability/error-reporting.ts): Sentry starts only
 * when SENTRY_DSN is set, and only in the Node.js runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Not awaited: a slow or absent database must not hold up the server.
  void reportDatabaseEncoding();
  if (!process.env.SENTRY_DSN) return;
  const [Sentry, { sentryOptions }] = await Promise.all([
    import("@sentry/nextjs"),
    import("@/lib/observability/error-reporting"),
  ]);
  Sentry.init(sentryOptions());
}

/**
 * A database that is not UTF-8 is reported once, at startup, with the steps
 * to fix it (db/encoding.ts, D-119) — before the first research run fails
 * to store a manufacturer's page. Nothing is changed.
 */
async function reportDatabaseEncoding() {
  if (!process.env.DATABASE_URL) return;
  try {
    const [{ db }, { checkDatabaseEncoding }, { logEvent }] = await Promise.all([
      import("@/db"),
      import("@/db/encoding"),
      import("@/lib/observability/log"),
    ]);
    const problem = await checkDatabaseEncoding(async (text) => {
      const result = (await db.execute(text)) as unknown;
      return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    });
    if (problem) {
      console.warn(`\nWARNING — ${problem}\n`);
      await logEvent("error", "database.encoding_unsupported", { message: problem.split("\n")[0] });
    }
  } catch {
    // An unreachable database is reported by the first request that needs it.
  }
}

/**
 * Unhandled server errors, reported as structured log lines
 * (PRODUCTION-READINESS 22.1, docs/OBSERVABILITY.md).
 *
 * Next.js calls this for errors in rendering, route handlers, server actions
 * and the proxy. Only the path (not the query string, which can carry an
 * email), the method, the route and the error's digest and message are
 * logged — and the message is redacted like every other log line. The request
 * id set by proxy.ts ties it to the rest of the request's logs. With error
 * tracking configured, the same event is sent to Sentry by `logEvent`.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { logEvent } = await import("@/lib/observability/log");
  const header = request.headers["x-request-id"];
  await logEvent("error", "request.failed", {
    requestId: Array.isArray(header) ? header[0] : header,
    method: request.method,
    path: request.path.split("?")[0],
    routePath: context.routePath,
    routeType: context.routeType,
    renderSource: "renderSource" in context ? context.renderSource : undefined,
    digest: error && typeof error === "object" && "digest" in error ? String(error.digest) : undefined,
    error,
  });
};
