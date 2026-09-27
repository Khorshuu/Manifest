import { eq } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { isStrongModelKey, variantDescriptor } from "@/lib/pkb/identity-labels";
import { labelKey } from "@/lib/pkb/normalize";
import { groundedKnowledge } from "@/lib/pkb/publish";
import { reassessResolution } from "@/lib/pkb/resolution";
import { updateProduct } from "./products";

/**
 * Cleaning up identity typed into the wrong field (D-123 follow-up).
 *
 * "Shade 10" in Model, "(1N)" in Model number and "10" in MPN cannot identify
 * a product, and D-123 already stops them from doing so. They still sit in the
 * identity fields, though, and the editor still shows them as the model. Once
 * the knowledge base has established what the product's version actually is —
 * a verified or staff-entered colour, shade or size — they are offered for
 * reclassification: a person confirms, and the weak values leave the identity
 * fields through the ordinary product save (history, audit, knowledge sync and
 * search refresh as for any edit), the established version stays, and the
 * identity is assessed again. Nothing happens on page load; nothing happens to
 * a real manufacturer code ("WH-1000XM5", "GLO-OC-WL-BLK", "G502").
 */

export type WeakIdentityField = "modelName" | "modelNumber" | "manufacturerPartNumber";

const FIELD_LABEL: Record<WeakIdentityField, string> = {
  modelName: "Model",
  modelNumber: "Model number",
  manufacturerPartNumber: "Manufacturer part number",
};

const IDENTITY_KEY: Record<WeakIdentityField, "modelName" | "modelNumber" | "mpn"> = {
  modelName: "modelName",
  modelNumber: "modelNumber",
  manufacturerPartNumber: "mpn",
};

export type IdentityCleanupIssue = {
  field: WeakIdentityField;
  label: string;
  value: string;
  /** The established fact this value restates, when one does ("Colour: Black (010)"). */
  equivalent: string | null;
};

export type IdentityCleanup = {
  issues: IdentityCleanupIssue[];
  /** What the knowledge base has established about the version: the reason cleanup is offered. */
  established: { label: string; value: string }[];
};

/** Numbers as a person reads them: "010" is 10. */
function numbers(value: string): string[] {
  return [...value.matchAll(/\d+/g)].map((match) => match[0].replace(/^0+(?=\d)/, ""));
}

/** Whether a weak value says what an established version fact says. */
function restates(value: string, fact: string): boolean {
  const descriptor = variantDescriptor(value);
  const core = descriptor ? descriptor.value : value;
  const ours = numbers(core);
  const theirs = new Set(numbers(fact));
  if (ours.length > 0 && ours.every((number) => theirs.has(number))) return true;
  const words = labelKey(core).split(" ").filter((word) => word.length > 1 && !/^\d+$/.test(word));
  const factWords = new Set(labelKey(fact).split(" "));
  return words.length > 0 && words.every((word) => factWords.has(word));
}

/** A label that names a version's dimension: "Colour", "Shade", "Size", "Flavour". */
function isVersionLabel(label: string): boolean {
  return variantDescriptor(`${label} x`) !== null;
}

/**
 * The weak identity values a product carries, offered for cleanup only when
 * its version is established. Read-only.
 */
export async function identityCleanup(productId: string): Promise<IdentityCleanup | null> {
  const [listing] = await db
    .select({ details: products.details, pkbProductId: products.pkbProductId })
    .from(products)
    .where(eq(products.id, productId));
  if (!listing) return null;
  const details = (listing.details ?? {}) as Record<string, unknown>;

  const weak: { field: WeakIdentityField; value: string }[] = [];
  for (const field of Object.keys(FIELD_LABEL) as WeakIdentityField[]) {
    const raw = details[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = raw.trim();
    const isWeak = field === "modelName" ? variantDescriptor(value) !== null : !isStrongModelKey(value);
    if (isWeak) weak.push({ field, value });
  }
  if (weak.length === 0) return null;

  const knowledge = await groundedKnowledge(listing.pkbProductId);
  const established = knowledge.attributes
    .filter((attribute) => attribute.pkbVariantId === null && (attribute.key === "color" || attribute.key === "size" || isVersionLabel(attribute.label)))
    .map((attribute) => ({ label: attribute.label, value: attribute.value }));
  if (established.length === 0) return null;

  return {
    established,
    issues: weak.map(({ field, value }) => {
      const match = established.find((fact) => restates(value, fact.value));
      return { field, label: FIELD_LABEL[field], value, equivalent: match ? `${match.label}: ${match.value}` : null };
    }),
  };
}

/**
 * Takes the confirmed weak values out of the identity fields. Checked again
 * on the server: only fields that are still weak, on a product whose version is
 * still established, are cleared. Everything else about the save is the
 * ordinary product update.
 */
export async function reclassifyWeakIdentity(
  actor: SessionUser | null,
  productId: string,
  fields: WeakIdentityField[],
): Promise<{ cleared: IdentityCleanupIssue[]; resolution: string }> {
  const staff = requirePermission(actor, "catalog.manage");
  const cleanup = await identityCleanup(productId);
  if (!cleanup) throw new NotFoundError("There is nothing to reclassify on this product.");
  const wanted = new Set(fields);
  const cleared = cleanup.issues.filter((issue) => wanted.has(issue.field));
  if (cleared.length === 0) throw new ValidationError("Choose at least one value that is still waiting to be reclassified.", "nothing_to_reclassify");

  const identity = Object.fromEntries(cleared.map((issue) => [IDENTITY_KEY[issue.field], null]));
  await updateProduct(staff, productId, { identity } as Parameters<typeof updateProduct>[2]);

  const [listing] = await db.select({ pkbProductId: products.pkbProductId }).from(products).where(eq(products.id, productId));
  const assessment = listing?.pkbProductId ? await reassessResolution(staff, listing.pkbProductId) : null;

  await recordAudit({
    actorUserId: staff.id,
    action: "product.identity_reclassified",
    entityType: "product",
    entityId: productId,
    before: { identity: Object.fromEntries(cleared.map((issue) => [issue.field, issue.value])) },
    after: {
      cleared: cleared.map((issue) => issue.field),
      because: cleanup.established.map((fact) => `${fact.label}: ${fact.value}`),
      equivalents: Object.fromEntries(cleared.map((issue) => [issue.field, issue.equivalent])),
      resolution: assessment?.state ?? null,
    },
  });
  return { cleared, resolution: assessment?.state ?? "unknown" };
}
