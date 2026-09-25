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

/*
 * Failures that will fail again, identically, however often they are retried
 * (D-119).
 *
 * A background job is retried with backoff because most of what stops one is
 * temporary: a dropped connection, a deadlock, a provider timing out. A value
 * the database cannot store is not temporary. A page carrying a character the
 * database's encoding has no byte for failed five times in a row, and each of
 * those five attempts fetched the manufacturer's page again first.
 *
 * Only SQLSTATEs that describe the data or the statement itself are listed:
 * an encoding the database cannot represent, a value too long or malformed for
 * its column, a NOT NULL or CHECK constraint, a statement referring to
 * something that does not exist. A unique or foreign-key violation is not
 * here — both can be a race another transaction is about to settle, and the
 * code that meets one usually handles it already. Nothing transient is here:
 * connection failures (class 08), serialization failures and deadlocks
 * (class 40), and resource exhaustion (class 53) are all still retried.
 */
const PERMANENT_SQLSTATES = new Set([
  "22021", // character_not_in_repertoire — e.g. NUL in text
  "22P05", // untranslatable_character — no byte for it in the database encoding
  "22001", // string_data_right_truncation
  "22003", // numeric_value_out_of_range
  "22007", // invalid_datetime_format
  "22008", // datetime_field_overflow
  PG_INVALID_TEXT_REPRESENTATION,
  "23502", // not_null_violation
  PG_CHECK_VIOLATION,
  "42601", // syntax_error
  "42703", // undefined_column
  "42P01", // undefined_table
  "42883", // undefined_function
]);

/** SQLSTATEs that mean the database cannot store the text it was given. */
const ENCODING_SQLSTATES = new Set(["22021", "22P05"]);

export function isPermanentDatabaseError(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return code !== null && PERMANENT_SQLSTATES.has(code);
}

export function isEncodingDatabaseError(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return code !== null && ENCODING_SQLSTATES.has(code);
}

/**
 * The database's own account of a failure, bounded and safe to keep.
 *
 * Drizzle's wrapper message is "Failed query: <the statement> params: <every
 * bound value>". The bound values are the page that was being stored — half a
 * megabyte of it — so a 500-character slice of the wrapper was nothing but
 * the start of an INSERT, and the one line that said what was wrong was cut
 * off. This keeps what an administrator needs: the SQLSTATE, PostgreSQL's
 * message and detail, the table and constraint it names, and the first words
 * of the statement. The bound values are never included, and neither is a
 * stack trace.
 */
export function describeDatabaseError(error: unknown, max = 500): string {
  const root = walkNode(error, (node) => typeof node.code === "string" && SQLSTATE.test(node.code));
  const top = error instanceof Error ? error.message : String(error);
  if (!root) return oneLine(top.split(/\nparams:/)[0]).slice(0, max);

  const parts = [`[${String(root.code)}] ${oneLine(String(root.message ?? ""))}`];
  if (typeof root.detail === "string" && root.detail) parts.push(`detail: ${oneLine(root.detail)}`);
  const table = typeof root.table_name === "string" ? root.table_name : typeof root.table === "string" ? root.table : null;
  if (table) parts.push(`table: ${table}`);
  const constraint = databaseConstraint(error);
  if (constraint) parts.push(`constraint: ${constraint}`);
  const query = walkNode(error, (node) => typeof node.query === "string");
  if (query) parts.push(`while: ${oneLine(String(query.query)).slice(0, 80)}`);
  return parts.join(" · ").slice(0, max);
}

function walkNode(error: unknown, test: (node: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    if (test(current as Record<string, unknown>)) return current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
