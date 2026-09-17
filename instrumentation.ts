import type { Instrumentation } from "next";

/**
 * Unhandled server errors, reported as structured log lines
 * (PRODUCTION-READINESS 22.1, docs/OBSERVABILITY.md).
 *
 * Next.js calls this for errors in rendering, route handlers, server actions
 * and the proxy. Only the path (not the query string, which can carry an
 * email), the method, the route and the error's digest and message are
 * logged — and the message is redacted like every other log line. The request
 * id set by proxy.ts ties it to the rest of the request's logs.
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
