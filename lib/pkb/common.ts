import { sql, type SQL } from "drizzle-orm";

/**
 * Shared plumbing for the Product Knowledge Base services.
 */

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- the base
   database or an open transaction, which differ only in generics */
export type Executor = any;

/** Rows of a hand-written query, whichever driver is underneath. */
export async function queryRows<T>(executor: Executor, query: SQL): Promise<T[]> {
  const result: unknown = await executor.execute(query);
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export class PkbError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "PkbError";
    this.status = status;
    this.details = details;
  }
}

/** A change would overwrite a value someone locked (I-4). */
export class PkbLockedError extends PkbError {
  constructor(label: string) {
    super(
      `${label} is locked in the product knowledge base. Unlock it there before changing it here.`,
      409,
      { locked: label },
    );
    this.name = "PkbLockedError";
  }
}

/**
 * Who a mirrored legacy change is attributed to, which decides the
 * verification state of the values it creates or changes (D-070):
 *
 *  - `staff`: a staff member saved it — changed values are MANUAL;
 *  - `staff_copy`: a staff member duplicated a listing — the copied values are
 *    UNVERIFIED, because nobody checked them for the new product;
 *  - `legacy`: nobody is known (the import, a script, a path that bypassed
 *    `lib/`) — values are LEGACY, and nothing a person or evidence decided is
 *    overwritten.
 */
export type Attribution =
  | { kind: "staff"; actorId: string }
  | { kind: "staff_copy"; actorId: string }
  | { kind: "legacy" };

export const LEGACY: Attribution = { kind: "legacy" };

export function staffChange(actorId: string): Attribution {
  return { kind: "staff", actorId };
}

/**
 * Serializes knowledge writes for one listing until the transaction ends.
 * Every writer takes it before writing, in the same order (this lock, then
 * rows), so a staff save and the background sync cannot interleave.
 */
export async function lockListingKnowledge(executor: Executor, productId: string): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pkb:listing:${productId}`}, 0))`);
}

/** Serializes the legacy family mirror (category specifications → families). */
export async function lockFamilyMirror(executor: Executor): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended('pkb:families', 0))`);
}
