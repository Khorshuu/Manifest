import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { pkbClaims, pkbProducts, products } from "@/db/schema";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { queryRows, type Executor } from "./common";
import { listAttributeProposals, type AttributeProposalView } from "./discovery";
import { enrichmentRuns, sourceDocuments, type RunRow, type SourceDocumentView } from "./enrichment";
import { listClaims } from "./evidence";
import { getProductKnowledge, type ProductKnowledgeView } from "./facts";
import { listUnmappedLabels, type UnmappedLabelGroup } from "./mappings";
import { assessResolution, resolutionHistory, type ResolutionAssessment } from "./resolution";
import { evaluateVerification, loadVerificationContext, type VerificationQualification } from "./trust";

/**
 * The Product Intelligence view: everything a person needs to decide about one
 * product's knowledge, in one read. Nothing here writes; the decisions are the
 * actions in `review.ts`, `mappings.ts`, `discovery.ts` and `enrichment.ts`.
 */

export type ClaimView = Awaited<ReturnType<typeof listClaims>>[number] & {
  /** Only computed for open claims: whether a policy would allow VERIFIED now. */
  verification: VerificationQualification | null;
};

export type ProductIntelligence = {
  listingId: string | null;
  listingTitle: string | null;
  pkbProductId: string;
  name: string;
  resolution: ResolutionAssessment;
  resolutionDecidedAt: Date | null;
  knowledge: ProductKnowledgeView;
  claims: ClaimView[];
  documents: SourceDocumentView[];
  runs: RunRow[];
  proposals: AttributeProposalView[];
  unmappedLabels: UnmappedLabelGroup[];
  history: Awaited<ReturnType<typeof resolutionHistory>>;
};

/**
 * Reads one product's intelligence. The verification check runs only for the
 * open claims — it is several queries each, and a decided claim already
 * records the policy it was accepted under.
 */
export async function getProductIntelligence(
  actor: SessionUser | null,
  pkbProductId: string,
  executor: Executor = db,
): Promise<ProductIntelligence | null> {
  requirePermission(actor, "catalog.manage");

  const [product] = await executor
    .select({
      id: pkbProducts.id,
      name: pkbProducts.name,
      resolutionDecidedAt: pkbProducts.resolutionDecidedAt,
    })
    .from(pkbProducts)
    .where(eq(pkbProducts.id, pkbProductId));
  if (!product) return null;

  const [listing] = await executor
    .select({ id: products.id, title: products.title })
    .from(products)
    .where(eq(products.pkbProductId, pkbProductId));

  const [resolution, knowledge, rawClaims, documents, runs, proposals, history] = await Promise.all([
    assessResolution(executor, pkbProductId),
    getProductKnowledge(executor, pkbProductId),
    listClaims(executor, pkbProductId),
    sourceDocuments(executor, pkbProductId),
    enrichmentRuns(executor, pkbProductId),
    listAttributeProposals(executor, pkbProductId),
    resolutionHistory(executor, pkbProductId),
  ]);

  // The product exists, so its knowledge view does too.
  if (!knowledge) return null;

  /*
   * Every open claim is judged against the same product-level evidence — the
   * registry, the family lineage, the active policies, the other claims on the
   * slot — so that evidence is read once and handed to each judgement (risk
   * R-9). The verdicts are identical; what changes is that a product with
   * thirty open claims no longer issues thirty rounds of the same six reads.
   */
  const openClaims = rawClaims.filter(
    (row: (typeof rawClaims)[number]) => row.claim.status === "SUGGESTED" || row.claim.status === "CONFLICT",
  );
  const verificationContext =
    openClaims.length > 0 ? await loadVerificationContext(executor, pkbProductId) : undefined;

  const claims: ClaimView[] = [];
  for (const row of rawClaims) {
    const open = row.claim.status === "SUGGESTED" || row.claim.status === "CONFLICT";
    claims.push({
      ...row,
      verification: open ? await evaluateVerification(executor, row.claim.id, verificationContext) : null,
    });
  }

  const unmappedLabels = listing
    ? (await listUnmappedLabels(executor, { limit: 500 })).filter((group) =>
        group.samples.some((sample) => sample.productId === listing.id),
      )
    : [];

  return {
    listingId: listing?.id ?? null,
    listingTitle: listing?.title ?? null,
    pkbProductId,
    name: product.name,
    resolution,
    resolutionDecidedAt: product.resolutionDecidedAt,
    knowledge,
    claims,
    documents,
    runs,
    proposals,
    unmappedLabels,
    history,
  };
}

/** Products whose knowledge needs someone: conflicts, waiting claims or labels. */
export type IntelligenceQueueRow = {
  pkbProductId: string;
  listingId: string | null;
  title: string;
  resolutionState: string;
  openClaims: number;
  conflicts: number;
  openProposals: number;
  unmappedRows: number;
};

export async function intelligenceQueue(
  actor: SessionUser | null,
  options: { limit?: number } = {},
  executor: Executor = db,
): Promise<IntelligenceQueueRow[]> {
  requirePermission(actor, "catalog.manage");
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = await queryRows<{
    pkb_product_id: string;
    listing_id: string | null;
    title: string;
    resolution_state: string;
    open_claims: number;
    conflicts: number;
    open_proposals: number;
    unmapped_rows: number;
  }>(
    executor,
    sql`
      select kp.id as pkb_product_id,
             p.id as listing_id,
             coalesce(p.title, kp.name) as title,
             kp.resolution_state,
             count(distinct c.id) filter (where c.status = 'SUGGESTED')::int as open_claims,
             count(distinct c.id) filter (where c.status = 'CONFLICT')::int as conflicts,
             count(distinct pr.id) filter (where pr.status = 'open')::int as open_proposals,
             count(distinct u.id) filter (where u.status = 'open')::int as unmapped_rows
      from pkb_products kp
      left join products p on p.pkb_product_id = kp.id
      left join pkb_claims c on c.pkb_product_id = kp.id
      left join pkb_attribute_proposals pr on pr.pkb_product_id = kp.id
      left join pkb_unmapped_values u on u.product_id = p.id
      where kp.status = 'active'
      group by kp.id, p.id, p.title, kp.name, kp.resolution_state
      having count(distinct c.id) filter (where c.status in ('SUGGESTED', 'CONFLICT')) > 0
          or count(distinct pr.id) filter (where pr.status = 'open') > 0
          or count(distinct u.id) filter (where u.status = 'open') > 0
      order by conflicts desc, open_claims desc, unmapped_rows desc
      limit ${limit}
    `,
  );
  return rows.map((row) => ({
    pkbProductId: row.pkb_product_id,
    listingId: row.listing_id,
    title: row.title,
    resolutionState: row.resolution_state,
    openClaims: row.open_claims,
    conflicts: row.conflicts,
    openProposals: row.open_proposals,
    unmappedRows: row.unmapped_rows,
  }));
}

/** Open claims of one slot, for the conflict panel. */
export async function slotClaims(executor: Executor, pkbProductId: string, definitionId: string) {
  return executor
    .select()
    .from(pkbClaims)
    .where(
      and(
        eq(pkbClaims.pkbProductId, pkbProductId),
        eq(pkbClaims.definitionId, definitionId),
        inArray(pkbClaims.status, ["SUGGESTED", "CONFLICT"]),
      ),
    );
}

// ------------------------------------------------------ vocabulary & trust

export type VocabularyView = {
  definitions: { id: string; key: string; label: string; dataType: string; cardinality: string; status: string }[];
  families: { id: string; name: string; status: string; mirrored: boolean }[];
  labelMappings: {
    id: string;
    label: string;
    context: string;
    familyName: string | null;
    action: string;
    definitionLabel: string | null;
    decidedAt: Date;
  }[];
  registry: {
    id: string;
    brandName: string | null;
    matchKind: string;
    domain: string | null;
    providerKey: string | null;
    role: string;
    authorityTier: number | null;
    urlTemplate: string | null;
    status: string;
    note: string | null;
  }[];
  policies: { id: string; key: string; name: string; description: string; status: string }[];
  brandRelations: { id: string; brandName: string; relatedName: string; kind: string; status: string }[];
  unmappedLabels: UnmappedLabelGroup[];
};

/**
 * Everything the knowledge screen shows: the vocabulary, the trust decisions
 * and the labels waiting for a person. Reading is staff work; approving is
 * `knowledge.manage`, checked in the actions themselves.
 */
export async function getVocabularyView(
  actor: SessionUser | null,
  executor: Executor = db,
): Promise<VocabularyView> {
  requirePermission(actor, "catalog.manage");

  const [definitions, families, labelMappings, registry, policies, brandRelations, unmappedLabels] = await Promise.all([
    queryRows<VocabularyView["definitions"][number]>(
      executor,
      sql`select id, key, label, data_type as "dataType", cardinality, status
          from pkb_attribute_definitions where status <> 'retired' order by label`,
    ),
    queryRows<VocabularyView["families"][number]>(
      executor,
      sql`select id, name, status, legacy_category_id is not null as mirrored
          from pkb_families where status <> 'retired' order by name`,
    ),
    queryRows<VocabularyView["labelMappings"][number]>(
      executor,
      sql`select m.id, m.label, m.context, f.name as "familyName", m.action,
                 d.label as "definitionLabel", m.decided_at as "decidedAt"
          from pkb_label_mappings m
          left join pkb_families f on f.id = m.family_id
          left join pkb_attribute_definitions d on d.id = m.definition_id
          where m.status = 'approved'
          order by m.decided_at desc
          limit 200`,
    ),
    queryRows<VocabularyView["registry"][number]>(
      executor,
      sql`select r.id, b.name as "brandName", r.match_kind as "matchKind", r.domain,
                 r.provider_key as "providerKey", r.role, r.authority_tier as "authorityTier",
                 r.url_template as "urlTemplate", r.status, r.note
          from pkb_source_registry r
          left join pkb_brands b on b.id = r.brand_id
          where r.status <> 'rejected'
          order by (r.status = 'suggested') desc, b.name nulls first, r.domain`,
    ),
    queryRows<VocabularyView["policies"][number]>(
      executor,
      sql`select id, key, name, description, status from pkb_verification_policies order by name`,
    ),
    queryRows<VocabularyView["brandRelations"][number]>(
      executor,
      sql`select r.id, b.name as "brandName", rb.name as "relatedName", r.kind, r.status
          from pkb_brand_relations r
          join pkb_brands b on b.id = r.brand_id
          join pkb_brands rb on rb.id = r.related_brand_id
          where r.status <> 'rejected'
          order by (r.status = 'suggested') desc, b.name`,
    ),
    listUnmappedLabels(executor, { limit: 200 }),
  ]);

  return { definitions, families, labelMappings, registry, policies, brandRelations, unmappedLabels };
}
