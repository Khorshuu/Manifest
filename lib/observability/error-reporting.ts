import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { maskText, redact } from "./log";

/**
 * Error tracking through Sentry (docs/OBSERVABILITY.md), off unless
 * `SENTRY_DSN` is set.
 *
 * Every `error`-level log event is also sent to Sentry, so a job that died or a
 * payment that could not start alerts someone instead of waiting in the logs.
 * The same redaction rules as the logs apply, and a second pass (`scrubEvent`)
 * runs on everything the SDK itself attaches: cookies, request bodies, query
 * strings and most headers never leave the server, and emails and phone
 * numbers in error messages are masked.
 *
 * Server-side only. The browser SDK is not loaded: it would cost first-load
 * JavaScript on every page (the budget is 170 KB and the product page is at
 * 168 KB), and customer-facing pages already report their server errors here.
 */

export function errorReportingEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN) && process.env.NEXT_RUNTIME !== "edge";
}

/** Headers worth keeping for diagnosis; everything else is dropped. */
const KEPT_HEADERS = new Set(["user-agent", "x-request-id", "x-vercel-id", "content-type"]);

function withoutQuery(url: string | undefined): string | undefined {
  return url?.split("?")[0];
}

/** Removes what must not leave the server from an event the SDK built. */
export function scrubEvent<T extends ErrorEvent>(event: T): T {
  delete event.user;
  delete event.server_name;

  if (event.request) {
    const headers = event.request.headers ?? {};
    event.request = {
      method: event.request.method,
      url: withoutQuery(event.request.url),
      headers: Object.fromEntries(
        Object.entries(headers).filter(([name]) => KEPT_HEADERS.has(name.toLowerCase())),
      ),
    };
  }

  if (event.message) event.message = maskText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = maskText(exception.value);
  }
  if (event.extra) event.extra = redact(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = redact(event.contexts) as typeof event.contexts;
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => scrubBreadcrumb(crumb));
  }
  return event;
}

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const data = crumb.data ? (redact(crumb.data) as Record<string, unknown>) : undefined;
  if (data && typeof data.url === "string") data.url = withoutQuery(data.url);
  return {
    ...crumb,
    message: crumb.message ? maskText(crumb.message) : crumb.message,
    data,
  };
}

/** Options for `Sentry.init`, from the environment. */
export function sentryOptions() {
  const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
  return {
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
    sendDefaultPii: false,
    includeLocalVariables: false,
    // Performance tracing is off unless a rate is set for this environment.
    ...(Number.isFinite(tracesSampleRate) && tracesSampleRate > 0 ? { tracesSampleRate } : {}),
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

/**
 * Sends one error-level log event to Sentry. Never throws: failing to report
 * an error must not become a second error for the request that had the first.
 */
export async function reportError(event: string, fields: Record<string, unknown>): Promise<void> {
  if (!errorReportingEnabled()) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    const { error, requestId, ...rest } = fields;
    const cause = error instanceof Error ? error : new Error(event);
    Sentry.withScope((scope) => {
      scope.setTag("event", event);
      if (typeof requestId === "string") scope.setTag("request_id", requestId);
      scope.setExtras(redact({ ...rest, ...(error instanceof Error ? {} : { error }) }) as Record<string, unknown>);
      scope.setFingerprint(error instanceof Error ? ["{{ default }}", event] : [event]);
      Sentry.captureException(cause);
    });
    // A serverless function can be frozen as soon as the response is sent.
    await Sentry.flush(2000);
  } catch {
    // Reporting is best effort; the log line has already been written.
  }
}
