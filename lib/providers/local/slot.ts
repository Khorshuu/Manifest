import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { isPooledUrl } from "@/db/connection";
import { getLocalServicesConfig, localAiRuntime } from "./config";

/**
 * The local-AI slot: at most LOCAL_AI_CONCURRENCY heavy local-model calls at
 * once on this machine (D-127).
 *
 * Phase B ran two qwen2.5:7b generations side by side and both suffered: they
 * share one graphics card, so each ran slower and one gave up. Serialising
 * them in the calling code is not enough when several workers — the
 * scheduler's overlapping ticks, a preparation run and a staff member's
 * SeoPulse click — can each start one, possibly in different Node processes.
 *
 * Two layers, both released in `finally` whatever happened (success, provider
 * failure, timeout, malformed answer, exception):
 *
 *  - **In this process**, a set of taken slot numbers. Checked and taken
 *    synchronously, so two calls in the same process cannot both win one.
 *  - **Across processes**, a session-scoped PostgreSQL advisory lock per slot,
 *    held on one reserved connection for the duration of the call. A process
 *    that dies drops its connection, and the database releases the lock with
 *    it, so a crash cannot leave the slot taken.
 *
 * The session lock needs a direct connection: through a transaction pooler a
 * session lock is not pinned to anything — the lock and its unlock can reach
 * different server connections, leaving a slot taken by nobody, or two calls
 * each believing they hold it. A development database is direct. In a hosted
 * environment the process that runs local-AI work (the worker, D-133) must be
 * given the database's direct address as DATABASE_URL; a pooled address is
 * refused here rather than trusted, exactly as the migration lock refuses one
 * (db/migrate.ts).
 *
 * A call made while its caller already holds a slot — the job runner takes
 * one before running a local-AI job — runs inside it rather than queueing
 * behind itself.
 */

export class LocalAiQueueTimeoutError extends Error {
  readonly code = "OLLAMA_QUEUE_WAIT_TIMEOUT";
  constructor(waitedMs: number) {
    super(`The local AI was busy with other work for ${Math.round(waitedMs / 1000)} s, longer than this call may wait.`);
    this.name = "LocalAiQueueTimeoutError";
  }
}

export type LocalAiSlot = { index: number; release: () => Promise<void> };

const held = new AsyncLocalStorage<LocalAiSlot>();
const takenHere = new Set<number>();

/* eslint-disable @typescript-eslint/no-explicit-any -- postgres-js and PGlite
   clients differ; only `reserve` is looked for */
type Session = { tryLock(key: string): Promise<boolean>; unlock(key: string): Promise<void>; close(): void };

/**
 * The slot cannot be taken over this connection (D-133). Thrown, not returned
 * as "busy": a busy slot comes free, and this never will until the
 * environment is corrected, so the job fails with the reason on it.
 */
export class LocalAiSlotConnectionError extends Error {
  readonly code = "LOCAL_AI_SLOT_NEEDS_DIRECT_CONNECTION";
  constructor() {
    super(
      "The local-AI slot needs a direct database connection, and DATABASE_URL is a pooled address. " +
        "Give the process that runs local-AI jobs the database's direct (unpooled) address as DATABASE_URL.",
    );
    this.name = "LocalAiSlotConnectionError";
  }
}

/** Whether the slot's session lock can be trusted over `databaseUrl`. */
export function slotConnectionProblem(databaseUrl: string | undefined = process.env.DATABASE_URL): LocalAiSlotConnectionError | null {
  return databaseUrl && isPooledUrl(databaseUrl) ? new LocalAiSlotConnectionError() : null;
}

async function openSession(): Promise<Session> {
  const client = (db as any).$client;
  if (client && typeof client.reserve === "function") {
    const problem = slotConnectionProblem();
    if (problem) throw problem;
    // postgres-js: one connection kept for the call, so the lock and its
    // unlock happen in the same session.
    const reserved = await client.reserve();
    return {
      async tryLock(key) {
        const [row] = await reserved`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as ok`;
        return row?.ok === true;
      },
      async unlock(key) {
        await reserved`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
      },
      close() {
        reserved.release();
      },
    };
  }
  // One in-process connection (PGlite, in tests): the lock is re-entrant
  // there, so the in-process set is what serialises.
  return {
    async tryLock(key) {
      const result: any = await db.execute(sql`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as ok`);
      const rows = Array.isArray(result) ? result : (result?.rows ?? []);
      return rows[0]?.ok === true;
    },
    async unlock(key) {
      await db.execute(sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`);
    },
    close() {},
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function slotKey(index: number): string {
  return `local-ai:slot:${index}`;
}

/** Takes a free slot without waiting, or returns null when every slot is busy. */
export async function tryAcquireLocalAiSlot(concurrency = getLocalServicesConfig().LOCAL_AI_CONCURRENCY): Promise<LocalAiSlot | null> {
  for (let index = 0; index < concurrency; index += 1) {
    if (takenHere.has(index)) continue;
    takenHere.add(index);
    let session: Session | null = null;
    try {
      session = await openSession();
      if (await session.tryLock(slotKey(index))) {
        const owned = session;
        let released = false;
        return {
          index,
          async release() {
            if (released) return;
            released = true;
            try {
              await owned.unlock(slotKey(index));
            } finally {
              owned.close();
              takenHere.delete(index);
            }
          },
        };
      }
      session.close();
      takenHere.delete(index);
    } catch (error) {
      session?.close();
      takenHere.delete(index);
      throw error;
    }
  }
  return null;
}

/** Runs `work` as the holder of `slot`; calls inside it do not queue again. */
export function runHoldingLocalAiSlot<T>(slot: LocalAiSlot, work: () => Promise<T>): Promise<T> {
  return held.run(slot, work);
}

/** Whether the current call already holds a slot. */
export function holdsLocalAiSlot(): boolean {
  return held.getStore() !== undefined;
}

let queueOverride: { waitMs?: number; pollMs?: number } | undefined;

/** Test helper: a short queue wait and poll interval. */
export function setLocalAiQueueForTesting(options: { waitMs?: number; pollMs?: number } | undefined): void {
  queueOverride = options;
}

/**
 * Runs `work` holding a local-AI slot, waiting for one to come free. Gives up
 * with LocalAiQueueTimeoutError after the queue wait; the slot is released
 * however `work` ends.
 */
export async function withLocalAiSlot<T>(work: () => Promise<T>, options: { waitMs?: number; pollMs?: number } = {}): Promise<T> {
  if (holdsLocalAiSlot()) return work();
  const waitMs = options.waitMs ?? queueOverride?.waitMs ?? localAiRuntime().queueWaitMs;
  const pollMs = options.pollMs ?? queueOverride?.pollMs ?? 2_000;
  const started = Date.now();
  for (;;) {
    const slot = await tryAcquireLocalAiSlot();
    if (slot) {
      try {
        return await runHoldingLocalAiSlot(slot, work);
      } finally {
        await slot.release();
      }
    }
    const waited = Date.now() - started;
    if (waited >= waitMs) throw new LocalAiQueueTimeoutError(waited);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, waitMs - waited)));
  }
}
