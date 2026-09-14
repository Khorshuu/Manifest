/**
 * Recognising PostgreSQL failures by their SQLSTATE rather than their text.
 *
 * Drizzle wraps driver errors (`DrizzleQueryError`) and keeps the original on
 * `cause`; postgres-js and PGlite both put the SQLSTATE on `code`. Messages
 * change between versions and locales, codes do not.
 */

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_CHECK_VIOLATION = "23514";
export const PG_INVALID_TEXT_REPRESENTATION = "22P02";
export const PG_SERIALIZATION_FAILURE = "40001";
export const PG_DEADLOCK_DETECTED = "40P01";

const SQLSTATE = /^[0-9A-Z]{5}$/;

function walk(error: unknown, read: (node: Record<string, unknown>) => string | null) {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    const found = read(current as Record<string, unknown>);
    if (found) return found;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The SQLSTATE of a database error, however deeply it is wrapped. */
export function databaseErrorCode(error: unknown): string | null {
  return walk(error, (node) =>
    typeof node.code === "string" && SQLSTATE.test(node.code) ? node.code : null,
  );
}

/** The constraint a violation names: `constraint_name` (postgres-js) or `constraint` (PGlite). */
export function databaseConstraint(error: unknown): string | null {
  return walk(error, (node) => {
    if (typeof node.constraint_name === "string") return node.constraint_name;
    if (typeof node.constraint === "string") return node.constraint;
    return null;
  });
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (databaseErrorCode(error) !== PG_UNIQUE_VIOLATION) return false;
  return constraint === undefined || databaseConstraint(error) === constraint;
}

/** Failures that mean "another transaction got in the way", not "this is wrong". */
export function isTransientDatabaseError(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return code === PG_DEADLOCK_DETECTED || code === PG_SERIALIZATION_FAILURE;
}

export const DEFAULT_TRANSIENT_ATTEMPTS = 3;

/**
 * Runs `work` again when it fails for a transient reason, a bounded number of
 * times with jittered backoff.
 *
 * `work` must be a whole transaction: whatever it did before failing was
 * rolled back, so running it again cannot repeat a side effect. Anything that
 * reaches outside the database (a payment provider, an email) belongs after
 * the retried block, never inside it.
 */
export async function withTransientRetry<T>(
  work: (attempt: number) => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_TRANSIENT_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? 20;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      if (attempt >= attempts || !isTransientDatabaseError(error)) throw error;
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
