import { and, eq, lt, sql } from "drizzle-orm";
import { db, type Database } from "@/db";
import { skuReservations } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";

/**
 * The SKU service (DECISIONS.md D-037).
 *
 * Every product SKU the admin is offered comes from here, generated on the
 * server, never in the browser. A SKU moves through three states in
 * `sku_reservations`:
 *
 *   reserved  → finalized   the product was saved with it; permanent
 *   reserved  → released    the form was abandoned, cancelled or expired
 *
 * A released SKU can be generated again; a finalized one never can.
 *
 * Generation runs inside one transaction holding a Postgres advisory lock, so
 * two admins pressing "Add Product" at the same moment are served one after
 * the other and cannot be handed the same SKU. The partial unique index on
 * held SKUs is the second, independent guarantee.
 */

/** How long an unsaved form holds its SKU. Reopening the form renews it. */
export const SKU_HOLD_MS = 2 * 60 * 60 * 1000;

/** Arbitrary, fixed: the advisory-lock key that serialises SKU generation. */
const GENERATION_LOCK = 734_205_118;

/**
 * How SKUs look. One place, so the format can later be derived from the
 * product (brand, category, specifications) without touching the reservation
 * rules: a strategy only has to turn a number into a SKU and back.
 */
export type SkuStrategy = {
  /** SQL LIKE pattern matching every SKU this strategy could produce. */
  like: string;
  format(sequence: number): string;
  /** The sequence number inside a SKU, or null if it is not this format. */
  parse(sku: string): number | null;
};

export const defaultSkuStrategy: SkuStrategy = {
  like: "SKU-%",
  format: (sequence) => `SKU-${String(sequence).padStart(6, "0")}`,
  parse: (sku) => {
    const match = /^SKU-(\d{6,})$/.exec(sku);
    return match ? Number(match[1]) : null;
  },
};

export class SkuReservationError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
    this.name = "SkuReservationError";
  }
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/**
 * Frees holds whose time is up. Called before every generation (so a stale
 * hold never blocks a number) and by the scheduled maintenance sweep (so the
 * table does not depend on anyone opening the form).
 */
export async function releaseExpiredSkuReservations(
  executor: Executor = db,
): Promise<number> {
  const released = await executor
    .update(skuReservations)
    .set({ status: "released", releasedAt: new Date() })
    .where(
      and(
        eq(skuReservations.status, "reserved"),
        lt(skuReservations.expiresAt, new Date()),
      ),
    )
    .returning({ id: skuReservations.id });
  return released.length;
}

/**
 * The lowest free sequence number for a strategy. A number is taken if a
 * product or variant carries it, or it is reserved, or it was ever made
 * permanent. The lowest gap is used, which is what lets a released SKU come
 * back into use.
 */
async function nextFreeSku(tx: Tx, strategy: SkuStrategy): Promise<string> {
  const taken = rowsOf<{ sku: string }>(
    await tx.execute(sql`
      select sku from products where sku like ${strategy.like}
      union
      select sku from product_variants where sku like ${strategy.like}
      union
      select sku from sku_reservations
        where status in ('reserved', 'finalized') and sku like ${strategy.like}
    `),
  );

  const used = new Set<number>();
  for (const row of taken) {
    const number = strategy.parse(row.sku);
    if (number !== null) used.add(number);
  }

  let candidate = 1;
  while (used.has(candidate)) candidate += 1;
  return strategy.format(candidate);
}

export type SkuReservation = {
  id: string;
  sku: string;
  expiresAt: Date;
  /** True when an existing hold was renewed rather than a new SKU generated. */
  renewed: boolean;
};

/**
 * Reserves a SKU for an Add Product form.
 *
 * Given the id of a hold this admin already has — the form stores it, so a
 * refresh or a reopened tab sends it back — that hold is renewed and the same
 * SKU returned. A hold still marked reserved cannot have been given to anyone
 * else, even if its time ran out before a sweep noticed. Otherwise a new SKU
 * is generated and held.
 */
export async function reserveSku(
  actor: SessionUser | null,
  options: { reservationId?: string | null; strategy?: SkuStrategy } = {},
): Promise<SkuReservation> {
  const staff = requirePermission(actor, "catalog.manage");
  const strategy = options.strategy ?? defaultSkuStrategy;
  const expiresAt = new Date(Date.now() + SKU_HOLD_MS);

  return db.transaction(async (tx) => {
    if (options.reservationId) {
      const [renewed] = await tx
        .update(skuReservations)
        .set({ expiresAt })
        .where(
          and(
            eq(skuReservations.id, options.reservationId),
            eq(skuReservations.reservedBy, staff.id),
            eq(skuReservations.status, "reserved"),
          ),
        )
        .returning({ id: skuReservations.id, sku: skuReservations.sku });
      if (renewed) return { ...renewed, expiresAt, renewed: true };
    }

    // One generation at a time, across every connection, until commit.
    await tx.execute(sql`select pg_advisory_xact_lock(${GENERATION_LOCK})`);
    await releaseExpiredSkuReservations(tx);

    const sku = await nextFreeSku(tx, strategy);
    const [created] = await tx
      .insert(skuReservations)
      .values({ sku, reservedBy: staff.id, expiresAt })
      .returning({ id: skuReservations.id, sku: skuReservations.sku });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "sku.reserved",
        entityType: "sku",
        entityId: created.sku,
        after: { reservationId: created.id, expiresAt: expiresAt.toISOString() },
      },
      tx,
    );

    return { ...created, expiresAt, renewed: false };
  });
}

/**
 * Gives a held SKU back: the admin cancelled or abandoned the form. Only the
 * admin who holds it may release it, and only while it is still a hold — a
 * finalized SKU belongs to a product and is never released.
 */
export async function releaseSkuReservation(
  actor: SessionUser | null,
  reservationId: string,
): Promise<boolean> {
  const staff = requirePermission(actor, "catalog.manage");

  return db.transaction(async (tx) => {
    const [released] = await tx
      .update(skuReservations)
      .set({ status: "released", releasedAt: new Date() })
      .where(
        and(
          eq(skuReservations.id, reservationId),
          eq(skuReservations.reservedBy, staff.id),
          eq(skuReservations.status, "reserved"),
        ),
      )
      .returning({ sku: skuReservations.sku });

    if (!released) return false;

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "sku.released",
        entityType: "sku",
        entityId: released.sku,
        after: { reservationId },
      },
      tx,
    );
    return true;
  });
}

/**
 * Throws unless `sku` may be given to a product: not on another product or a
 * variant, not held by anyone else's unsaved form, and never made permanent
 * for a different product. `allowReservationId` is the caller's own hold.
 */
export async function assertSkuAssignable(
  executor: Executor,
  sku: string,
  options: { excludingProductId?: string; allowReservationId?: string | null } = {},
): Promise<void> {
  const clashes = rowsOf<{ kind: string; label: string | null; owner: string | null }>(
    await executor.execute(sql`
      select 'product' as kind, title as label, id::text as owner
        from products where sku = ${sku}
      union all
      select 'variant', sku, product_id::text from product_variants where sku = ${sku}
      union all
      select 'reserved', null, id::text from sku_reservations
        where sku = ${sku} and status = 'reserved'
      union all
      select 'permanent', null, product_id::text from sku_reservations
        where sku = ${sku} and status = 'finalized'
    `),
  );

  for (const clash of clashes) {
    if (clash.kind === "product" && clash.owner === options.excludingProductId) continue;
    if (clash.kind === "permanent" && clash.owner === options.excludingProductId) continue;
    if (clash.kind === "reserved" && clash.owner === options.allowReservationId) continue;

    throw new SkuReservationError(
      clash.kind === "product"
        ? `The SKU ${sku} already belongs to "${clash.label}".`
        : clash.kind === "variant"
          ? `The SKU ${sku} is already used by a product variant.`
          : clash.kind === "reserved"
            ? `The SKU ${sku} is being held for another new product. Choose a different one.`
            : `The SKU ${sku} was used by an earlier product and cannot be reused.`,
    );
  }
}

/**
 * Makes a product's SKU permanent, inside the transaction that saves the
 * product — so the product and the SKU's state commit or fail together.
 *
 * If the product took the SKU its form was holding, that hold becomes the
 * permanent record. If staff typed a different SKU, the hold is released and
 * the typed SKU is recorded as permanent instead. Either way the SKU the
 * product ends up with is on record, so it can never be generated again.
 */
export async function finalizeProductSku(
  tx: Tx,
  input: {
    actorId: string;
    productId: string;
    sku: string;
    reservationId?: string | null;
  },
): Promise<void> {
  const now = new Date();

  if (input.reservationId) {
    const [hold] = await tx
      .select({ id: skuReservations.id, sku: skuReservations.sku })
      .from(skuReservations)
      .where(
        and(
          eq(skuReservations.id, input.reservationId),
          eq(skuReservations.reservedBy, input.actorId),
          eq(skuReservations.status, "reserved"),
        ),
      )
      .for("update");

    if (hold && hold.sku === input.sku) {
      await tx
        .update(skuReservations)
        .set({ status: "finalized", productId: input.productId, finalizedAt: now })
        .where(eq(skuReservations.id, hold.id));
      await recordAudit(
        {
          actorUserId: input.actorId,
          action: "sku.finalized",
          entityType: "sku",
          entityId: hold.sku,
          after: { productId: input.productId, reservationId: hold.id },
        },
        tx,
      );
      return;
    }

    if (hold) {
      await tx
        .update(skuReservations)
        .set({ status: "released", releasedAt: now })
        .where(eq(skuReservations.id, hold.id));
      await recordAudit(
        {
          actorUserId: input.actorId,
          action: "sku.released",
          entityType: "sku",
          entityId: hold.sku,
          after: { reservationId: hold.id, replacedBy: input.sku },
        },
        tx,
      );
    }
  }

  await recordPermanentSku(tx, input.actorId, input.productId, input.sku);
}

/**
 * Records a SKU as permanently used by a product, if it is not already on
 * record for it. Used for typed SKUs and when a saved product's SKU changes,
 * so the old SKU stays spent.
 */
export async function recordPermanentSku(
  tx: Tx,
  actorId: string,
  productId: string,
  sku: string,
): Promise<void> {
  const inserted = rowsOf<{ id: string }>(
    await tx.execute(sql`
      insert into sku_reservations (sku, status, reserved_by, product_id, expires_at, finalized_at)
      values (${sku}, 'finalized', ${actorId}, ${productId}, now(), now())
      on conflict do nothing
      returning id
    `),
  );

  if (inserted.length > 0) {
    await recordAudit(
      {
        actorUserId: actorId,
        action: "sku.finalized",
        entityType: "sku",
        entityId: sku,
        after: { productId },
      },
      tx,
    );
  }
}
