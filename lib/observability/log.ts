/**
 * Structured logs (PRODUCTION-READINESS 22.1, docs/OBSERVABILITY.md).
 *
 * One JSON object per line, so a log drain or the hosting dashboard can filter
 * by event, request id or outcome instead of searching free text. Every entry
 * passes through `redact` first: a log line must never carry a password, a
 * token, a secret, a card detail or a full email address or phone number,
 * whatever a caller hands it.
 */

export type LogLevel = "info" | "warn" | "error";

const SENSITIVE_KEY = /pass(word)?|secret|token|authori[sz]ation|cookie|signature|otp|totp|recovery|card|cvv|pan\b|session/i;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
/** Bangladeshi mobile numbers (01XXXXXXXXX, +8801XXXXXXXXX) and other E.164 numbers — not order numbers. */
const PHONE = /(?:\+?880|\b0)1[3-9]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b|\+\d{10,14}\b/g;

function maskText(value: string): string {
  return value.replace(EMAIL, "$1***@$2").replace(PHONE, (match) => `***${match.slice(-3)}`);
}

/** A copy safe to log: sensitive keys replaced, emails and phone numbers masked. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return maskText(value);
  if (value instanceof Error) {
    return { name: value.name, message: maskText(value.message), stack: value.stack?.split("\n").slice(0, 6).join("\n") };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : redact(entry, depth + 1),
      ]),
    );
  }
  return value;
}

/** The request id proxy.ts assigned, when the call happens inside a request. */
async function requestId(): Promise<string | undefined> {
  try {
    const { headers } = await import("next/headers");
    return (await headers()).get("x-request-id") ?? undefined;
  } catch {
    // Outside a request: a job, a script, a test.
    return undefined;
  }
}

export async function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): Promise<void> {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    requestId: fields.requestId ?? (await requestId()),
    ...(redact(fields) as Record<string, unknown>),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/**
 * Runs work and logs how long it took and how it ended. The work's own error
 * is rethrown untouched; the log records its name and message, redacted.
 */
export async function timed<T>(
  event: string,
  fields: Record<string, unknown>,
  work: () => Promise<T>,
  describe: (result: T) => Record<string, unknown> = () => ({}),
): Promise<T> {
  const started = performance.now();
  try {
    const result = await work();
    await logEvent("info", event, { ...fields, outcome: "ok", durationMs: Math.round(performance.now() - started), ...describe(result) });
    return result;
  } catch (error) {
    const known = error && typeof error === "object" && "status" in error && Number((error as { status: unknown }).status) < 500;
    await logEvent(known ? "warn" : "error", event, {
      ...fields,
      outcome: "failed",
      durationMs: Math.round(performance.now() - started),
      error,
    });
    throw error;
  }
}
