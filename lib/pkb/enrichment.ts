import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  pkbEnrichmentRuns,
  pkbEvidence,
  pkbProductSources,
  pkbProducts,
  pkbSourceDocuments,
  pkbSources,
  type PkbAcquisitionMethod,
  type PkbProviderState,
  type PkbSourceType,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import { enqueueJob } from "@/lib/jobs/runner";
import { logEvent } from "@/lib/observability/log";
import { getProductResearchProvider, type ResearchQuery } from "@/lib/providers/research";
import { PkbError, queryRows, type Executor } from "./common";
import { proposeAttribute } from "./discovery";
import { extractDocument, type Extraction } from "./extract";
import { normalizeIdentifier } from "./identifiers";
import { loadLabelMappings, resolveLabel } from "./mappings";
import { checkRobots } from "./net/robots";
import { decodeBody, safeFetch } from "./net/safe-fetch";
import { cleanText, labelKey, normalizeUrl } from "./normalize";
import { canEnrich, loadIdentity, refreshResolution, type ProductIdentity } from "./resolution";
import { createClaim } from "./review";
import { approvedRegistryFor, matchRegistry, trustedBrandIds } from "./trust";
import { loadDefinitions } from "./vocabulary";

/**
 * The safe enrichment pipeline (D-074): IDENTIFY, FIND or RECEIVE SOURCES,
 * EXTRACT, NORMALIZE, VALIDATE, VERIFY, PROPOSE. Review and APPLY are a
 * person's job and live in `review.ts`.
 *
 * Nothing here writes a fact. A run retrieves documents, records what it read
 * as evidence, and proposes claims that a person accepts or rejects. Three
 * rules shape it.
 *
 *  - It only runs on a product whose identity is settled (VERIFIED or
 *    HIGH_CONFIDENCE). Enriching an ambiguous product is how a 512 GB page
 *    ends up describing the 256 GB listing.
 *  - A retrieved document is only used when its own identity signals agree
 *    with the product's. A page that mentions a different model number is
 *    kept, marked `mismatch`, and produces nothing.
 *  - Retrieval goes through `safeFetch` and robots.txt. Access controls are
 *    never bypassed; a 401, 403 or 429 is recorded as a refusal.
 */

const MAX_CANDIDATES = 12;
const MAX_PAIRS_PER_DOCUMENT = 120;

export type EnrichmentRequest = {
  pkbProductId: string;
  /** Staff-supplied pages to read in this run, besides the registry's. */
  urls?: string[];
  note?: string | null;
};

export type RunRow = typeof pkbEnrichmentRuns.$inferSelect;

function requestKeyFor(pkbProductId: string, urls: string[], stamp: string): string {
  return createHash("sha256").update(JSON.stringify([pkbProductId, [...urls].sort(), stamp])).digest("hex").slice(0, 48);
}

/**
 * Asks for a run. The work happens in a job, not on the request: retrieval is
 * slow and must not hold a staff request open. Idempotent inside one minute
 * for the same product and URLs, so a double click is one run.
 */
export async function requestEnrichment(
  actor: SessionUser | null,
  input: EnrichmentRequest,
): Promise<{ runId: string; status: RunRow["status"]; blockedReason: string | null; alreadyQueued: boolean }> {
  const staff = requirePermission(actor, "catalog.manage");
  const urls = [...new Set((input.urls ?? []).map((url) => url.trim()).filter(Boolean))];
  const minute = new Date().toISOString().slice(0, 16);
  const requestKey = requestKeyFor(input.pkbProductId, urls, minute);

  return db.transaction(async (tx) => {
    const [exists] = await tx.select({ id: pkbProducts.id }).from(pkbProducts).where(eq(pkbProducts.id, input.pkbProductId));
    if (!exists) throw new PkbError("That product is not in the knowledge base.", 404);

    // The state is re-checked here rather than trusted: the identifiers may
    // have changed since the last assessment, in either direction.
    const assessed = await refreshResolution(tx, input.pkbProductId);
    const product = { id: exists.id, resolutionState: assessed.state };

    const [existing] = await tx.select().from(pkbEnrichmentRuns).where(eq(pkbEnrichmentRuns.requestKey, requestKey));
    if (existing) {
      return {
        runId: existing.id,
        status: existing.status,
        blockedReason: existing.blockedReason,
        alreadyQueued: true,
      };
    }

    const blockedReason = canEnrich(product.resolutionState)
      ? null
      : `The product's identity is ${product.resolutionState}. Resolve the identity before enriching it.`;

    const [run] = await tx
      .insert(pkbEnrichmentRuns)
      .values({
        pkbProductId: product.id,
        status: blockedReason ? "blocked" : "queued",
        requestKey,
        requestedBy: staff.id,
        resolutionState: product.resolutionState,
        blockedReason,
      })
      .returning();

    // The staff-supplied pages belong to the product, not to this run, so a
    // later run reads them again without being handed them a second time.
    for (const url of urls) {
      const sourceId = await ensureUrlSource(tx, { url, staffId: staff.id });
      await tx
        .insert(pkbProductSources)
        .values({ pkbProductId: product.id, sourceId, addedBy: staff.id })
        .onConflictDoNothing();
    }

    if (!blockedReason) {
      await enqueueJob({ kind: "pkb.enrich_product", payload: { runId: run.id }, dedupeKey: `pkb.enrich:${run.id}` }, tx);
    }

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.enrichment_requested",
        entityType: "pkb_product",
        entityId: product.id,
        after: { runId: run.id, status: run.status, urls: urls.length, blockedReason, note: input.note ?? null },
      },
      tx,
    );
    return { runId: run.id, status: run.status, blockedReason, alreadyQueued: false };
  });
}

/** Registers a page as a source for a product, without retrieving it yet. */
export async function addProductSource(
  actor: SessionUser | null,
  pkbProductId: string,
  input: { url: string; note?: string | null },
): Promise<{ sourceId: string }> {
  const staff = requirePermission(actor, "catalog.manage");
  return db.transaction(async (tx) => {
    const [product] = await tx.select({ id: pkbProducts.id }).from(pkbProducts).where(eq(pkbProducts.id, pkbProductId));
    if (!product) throw new PkbError("That product is not in the knowledge base.", 404);
    const sourceId = await ensureUrlSource(tx, { url: input.url, staffId: staff.id, title: input.note ?? null });
    await tx.insert(pkbProductSources).values({ pkbProductId: product.id, sourceId, addedBy: staff.id }).onConflictDoNothing();
    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.source_added",
        entityType: "pkb_product",
        entityId: product.id,
        after: { sourceId, url: input.url },
      },
      tx,
    );
    return { sourceId };
  });
}

/**
 * Takes a document a person supplies — a specification sheet they hold, a
 * manufacturer PDF turned into text — and runs the extract and propose steps
 * on it. No network access: the text is the evidence.
 */
export async function provideDocument(
  actor: SessionUser | null,
  pkbProductId: string,
  input: { title: string; content: string; contentType?: string; sourceType?: PkbSourceType; url?: string | null },
): Promise<EnrichmentOutcome> {
  const staff = requirePermission(actor, "catalog.manage");
  const content = input.content;
  if (!content.trim()) throw new PkbError("The document is empty.");

  return db.transaction(async (tx) => {
    const identity = await loadIdentity(tx, pkbProductId);
    if (!identity) throw new PkbError("That product is not in the knowledge base.", 404);

    const [source] = await tx
      .insert(pkbSources)
      .values({
        sourceType: input.sourceType ?? "admin_official_document",
        acquisitionMethod: "staff_upload",
        origin: "MANUAL_ADMIN",
        usageRights: "internal_only",
        url: input.url ?? null,
        title: cleanText(input.title) || "Provided document",
        contentSha256: createHash("sha256").update(content).digest("hex"),
        retrievedAt: new Date(),
        createdBy: staff.id,
      })
      .returning({ id: pkbSources.id });

    const extraction = extractDocument(content, input.contentType ?? "text/plain");
    const [document] = await tx
      .insert(pkbSourceDocuments)
      .values({
        sourceId: source.id,
        pkbProductId,
        status: "provided",
        contentType: input.contentType ?? "text/plain",
        byteSize: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
        textContent: extraction.text.slice(0, 200_000),
        structuredData: extraction.structuredData.length > 0 ? extraction.structuredData : null,
        identityMatch: "not_checked",
        createdBy: staff.id,
      })
      .returning({ id: pkbSourceDocuments.id });

    await tx.insert(pkbProductSources).values({ pkbProductId, sourceId: source.id, addedBy: staff.id }).onConflictDoNothing();

    // A document a person hands over is taken as being about this product:
    // they chose it. Its identity signals are still recorded.
    const outcome = await proposeFromExtraction(tx, {
      identity,
      extraction,
      sourceId: source.id,
      documentId: document.id,
      runId: null,
      actorId: staff.id,
      extractionMethodOf: (pair) => pair.method,
    });

    await recordAudit(
      {
        actorUserId: staff.id,
        action: "knowledge.source_added",
        entityType: "pkb_product",
        entityId: pkbProductId,
        after: { sourceId: source.id, documentId: document.id, ...outcome },
      },
      tx,
    );
    return outcome;
  });
}

/**
 * Attaches one page to a product from inside a caller’s transaction (D-112).
 *
 * `addProductSource` above is the same thing for a request that arrives on
 * its own and therefore checks its own permission. This one is for a write
 * that has already been authorised and is already in a transaction — the
 * official address typed on the Add Product form, saved in the same
 * transaction as the product it belongs to, so a failed save leaves no
 * orphaned source behind.
 *
 * Attaching is not trusting. The address becomes a page the pipeline may read;
 * whether its domain is authoritative is still the Brand Source Registry’s
 * decision, taken by somebody with `knowledge.manage`, and the page is still
 * fetched through `safeFetch`, checked against robots.txt and matched against
 * the product’s identifiers before it proposes anything.
 *
 * Returns the source id, or null when the address is unusable.
 */
export async function attachProductSource(
  tx: Executor,
  input: { pkbProductId: string; url: string; staffId: string; title?: string | null },
): Promise<string | null> {
  const normalized = normalizeUrl(input.url);
  if (!normalized) return null;
  const sourceId = await ensureUrlSource(tx, { url: normalized, staffId: input.staffId, title: input.title ?? null });
  await tx
    .insert(pkbProductSources)
    .values({ pkbProductId: input.pkbProductId, sourceId, addedBy: input.staffId })
    .onConflictDoNothing();
  return sourceId;
}

/**
 * The source row for one page staff named, reused when the same address comes
 * back so a product does not collect duplicates of it.
 */
async function ensureUrlSource(
  tx: Executor,
  input: { url: string; staffId: string; title?: string | null },
): Promise<string> {
  const normalized = normalizeUrl(input.url);
  if (!normalized) throw new PkbError(`${input.url} is not a usable address.`);
  const domain = new URL(normalized).hostname.replace(/^www\./, "");
  const [existing] = await tx
    .select({ id: pkbSources.id })
    .from(pkbSources)
    .where(and(eq(pkbSources.urlNormalized, normalized), eq(pkbSources.acquisitionMethod, "staff_url")));
  if (existing) return existing.id;
  const [created] = await tx
    .insert(pkbSources)
    .values({
      sourceType: "public_web",
      acquisitionMethod: "staff_url",
      origin: "APPROVED_EXTERNAL_SOURCE",
      usageRights: "unknown",
      url: normalized,
      urlNormalized: normalized,
      domain,
      title: input.title ? cleanText(input.title) : null,
      createdBy: input.staffId,
    })
    .returning({ id: pkbSources.id });
  return created.id;
}

// ------------------------------------------------------------- the pipeline

export type EnrichmentOutcome = {
  claimsProposed: number;
  conflicts: number;
  proposalsCreated: number;
};

export type RunReport = EnrichmentOutcome & {
  runId: string;
  status: RunRow["status"];
  documentsRetrieved: number;
  documentsRefused: number;
  providers: PkbProviderState[];
  blockedReason: string | null;
};

type Candidate = {
  url: string;
  sourceType: PkbSourceType;
  acquisitionMethod: PkbAcquisitionMethod;
  authorityTier: number | null;
  registryEntryId: string | null;
  providerKey: string | null;
  title: string | null;
};

/**
 * Runs one requested enrichment. Retrieval happens outside a transaction (it
 * is slow and must not hold locks); each document's proposals are written in
 * their own transaction, so a failure halfway leaves the earlier documents'
 * evidence intact and the run marked failed.
 */
export async function runEnrichment(runId: string): Promise<RunReport> {
  const [run]: RunRow[] = await db.select().from(pkbEnrichmentRuns).where(eq(pkbEnrichmentRuns.id, runId));
  if (!run) throw new PkbError("That enrichment run does not exist.", 404);
  if (run.status === "completed" || run.status === "blocked") {
    return {
      runId,
      status: run.status,
      documentsRetrieved: run.documentsRetrieved,
      documentsRefused: run.documentsRefused,
      claimsProposed: run.claimsProposed,
      conflicts: run.conflicts,
      proposalsCreated: run.proposalsCreated,
      providers: run.providers,
      blockedReason: run.blockedReason,
    };
  }

  await db.update(pkbEnrichmentRuns).set({ status: "running", startedAt: new Date() }).where(eq(pkbEnrichmentRuns.id, runId));

  const report: RunReport = {
    runId,
    status: "running",
    documentsRetrieved: 0,
    documentsRefused: 0,
    claimsProposed: 0,
    conflicts: 0,
    proposalsCreated: 0,
    providers: [],
    blockedReason: null,
  };

  try {
    // 1. IDENTIFY.
    const identity = await loadIdentity(db, run.pkbProductId);
    if (!identity) throw new PkbError("That product is not in the knowledge base.", 404);
    const [product] = await db
      .select({ resolutionState: pkbProducts.resolutionState })
      .from(pkbProducts)
      .where(eq(pkbProducts.id, run.pkbProductId));
    if (!canEnrich(product.resolutionState)) {
      report.status = "blocked";
      report.blockedReason = `The product's identity is ${product.resolutionState}. Resolve the identity before enriching it.`;
      await finishRun(runId, report);
      return report;
    }

    // 2. FIND or RECEIVE SOURCES.
    const found = await findCandidates(identity);
    report.providers = found.providers;
    const robotsCache = new Map<string, string | null | "unreachable">();

    for (const candidate of found.candidates.slice(0, MAX_CANDIDATES)) {
      const outcome = await readCandidate(run, identity, candidate, robotsCache);
      if (outcome.retrieved) report.documentsRetrieved += 1;
      else report.documentsRefused += 1;
      report.claimsProposed += outcome.claimsProposed;
      report.conflicts += outcome.conflicts;
      report.proposalsCreated += outcome.proposalsCreated;
    }

    report.status = "completed";
    await finishRun(runId, report);
    return report;
  } catch (error) {
    report.status = "failed";
    await db
      .update(pkbEnrichmentRuns)
      .set({
        status: "failed",
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        providers: report.providers,
        documentsRetrieved: report.documentsRetrieved,
        documentsRefused: report.documentsRefused,
        claimsProposed: report.claimsProposed,
        conflicts: report.conflicts,
        proposalsCreated: report.proposalsCreated,
        finishedAt: new Date(),
      })
      .where(eq(pkbEnrichmentRuns.id, runId));
    logEvent("warn", "pkb.enrichment_failed", { runId, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function finishRun(runId: string, report: RunReport): Promise<void> {
  await db
    .update(pkbEnrichmentRuns)
    .set({
      status: report.status,
      blockedReason: report.blockedReason,
      providers: report.providers,
      documentsRetrieved: report.documentsRetrieved,
      documentsRefused: report.documentsRefused,
      claimsProposed: report.claimsProposed,
      conflicts: report.conflicts,
      proposalsCreated: report.proposalsCreated,
      finishedAt: new Date(),
    })
    .where(eq(pkbEnrichmentRuns.id, runId));
}

/**
 * Where a run's pages come from: the approved registry entries for the
 * product's trusted brands, the pages staff attached to the product, and a
 * research provider if one is configured. With nothing configured the first
 * two still work, and the provider's state is reported as NOT_CONFIGURED
 * rather than silently treated as "no sources exist" (A-6).
 */
async function findCandidates(identity: ProductIdentity): Promise<{ candidates: Candidate[]; providers: PkbProviderState[] }> {
  const candidates: Candidate[] = [];
  const providers: PkbProviderState[] = [];
  const seen = new Set<string>();
  const add = (candidate: Candidate) => {
    const key = candidate.url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const brandIds = await trustedBrandIds(db, identity.pkbProductId);
  const registry = await approvedRegistryFor(db, brandIds);
  const preferredDomains = registry
    .filter((entry) => entry.matchKind === "domain" && entry.domain && entry.role !== "blocked")
    .map((entry) => entry.domain!);

  // Registry templates: an official documentation page whose address is a
  // known shape, filled in from the product's own identifiers.
  for (const entry of registry) {
    if (!entry.urlTemplate || entry.role === "blocked") continue;
    for (const url of fillTemplate(entry.urlTemplate, identity)) {
      add({
        url,
        sourceType: sourceTypeForRole(entry.role),
        acquisitionMethod: "brand_registry",
        authorityTier: entry.authorityTier ?? null,
        registryEntryId: entry.id,
        providerKey: null,
        title: null,
      });
    }
  }

  // Pages staff attached to this product.
  const attached = await queryRows<{ url: string; source_type: string; acquisition_method: string; title: string | null }>(
    db,
    sql`select s.url, s.source_type, s.acquisition_method, s.title
        from pkb_product_sources ps
        join pkb_sources s on s.id = ps.source_id
        where ps.pkb_product_id = ${identity.pkbProductId} and s.url is not null`,
  );
  for (const row of attached) {
    add({
      url: row.url,
      sourceType: row.source_type as PkbSourceType,
      acquisitionMethod: row.acquisition_method as PkbAcquisitionMethod,
      authorityTier: null,
      registryEntryId: null,
      providerKey: null,
      title: row.title,
    });
  }

  // Automatic discovery, if the shop has any.
  const provider = getProductResearchProvider();
  const query: ResearchQuery = {
    name: identity.name,
    brand: identity.brands[0]?.name ?? null,
    modelNumbers: identity.modelKeys,
    gtins: identity.gtins.map((row) => row.gtin14),
    preferredDomains,
    limit: MAX_CANDIDATES,
  };
  const result = await provider.findSources(query);
  providers.push({
    provider: provider.key,
    status: result.status,
    message: result.status === "OK" ? `${result.candidates.length} candidate pages` : result.message,
  });
  if (result.status === "OK") {
    for (const found of result.candidates) {
      add({
        url: found.url,
        sourceType: "public_web",
        acquisitionMethod: "research_provider",
        authorityTier: null,
        registryEntryId: null,
        providerKey: provider.key,
        title: found.title,
      });
    }
  }

  return { candidates, providers };
}

function sourceTypeForRole(role: string): PkbSourceType {
  switch (role) {
    case "official_product":
      return "manufacturer_website";
    case "official_documentation":
      return "manufacturer_documentation";
    case "official_support":
      return "manufacturer_support";
    case "manufacturer_feed":
      return "manufacturer_feed";
    case "authorized_distributor":
      return "authorized_distributor";
    case "trusted_retailer":
      return "retailer";
    case "product_database":
      return "product_database";
    case "supplier_feed":
      return "supplier_feed";
    default:
      return "public_web";
  }
}

/** Fills a registry URL template from the product's identifiers. */
export function fillTemplate(template: string, identity: ProductIdentity): string[] {
  const values: Record<string, string[]> = {
    model: identity.modelKeys,
    mpn: identity.modelKeys,
    gtin: identity.gtins.map((row) => row.gtin14),
    slug: [identity.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")],
  };
  const tokens = [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  if (tokens.length === 0) return [template];
  let urls = [template];
  for (const token of tokens) {
    const options = values[token] ?? [];
    if (options.length === 0) return [];
    urls = urls.flatMap((url) => options.map((option) => url.replace(`{${token}}`, encodeURIComponent(option))));
  }
  return urls.slice(0, 4);
}

/**
 * Retrieves one candidate and, when it is about the product, proposes what it
 * says. Every refusal is recorded with its reason: robots.txt, a blocked
 * registry entry, an access control, a redirect into a private address.
 */
async function readCandidate(
  run: RunRow,
  identity: ProductIdentity,
  candidate: Candidate,
  robotsCache: Map<string, string | null | "unreachable">,
): Promise<EnrichmentOutcome & { retrieved: boolean }> {
  const empty = { claimsProposed: 0, conflicts: 0, proposalsCreated: 0 };
  const domain = (() => {
    try {
      return new URL(candidate.url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  })();

  const registry = await approvedRegistryFor(db, await trustedBrandIds(db, identity.pkbProductId));
  const match = matchRegistry(registry, { domain, url: candidate.url, providerKey: candidate.providerKey });
  if (match?.blocked) {
    await recordRefusal(run, candidate, domain, "the domain is blocked in the source registry");
    return { ...empty, retrieved: false };
  }

  const robots = await checkRobots(candidate.url, robotsCache);
  if (!robots.allowed) {
    await recordRefusal(run, candidate, domain, robots.reason, { robotsAllowed: false });
    return { ...empty, retrieved: false };
  }

  const fetched = await safeFetch(candidate.url);
  if (!fetched.ok) {
    await recordRefusal(run, candidate, domain, `${fetched.code}: ${fetched.reason}`, {
      robotsAllowed: true,
      httpStatus: fetched.status ?? null,
    });
    return { ...empty, retrieved: false };
  }

  const content = decodeBody(fetched.body, fetched.charset);
  const extraction = extractDocument(content, fetched.contentType);
  const sha256 = createHash("sha256").update(fetched.body).digest("hex");
  const verdict = identityVerdict(identity, extraction);

  return db.transaction(async (tx) => {
    const [source] = await tx
      .insert(pkbSources)
      .values({
        sourceType: candidate.sourceType,
        acquisitionMethod: candidate.acquisitionMethod,
        authorityTier: match?.tier ?? candidate.authorityTier ?? null,
        origin: candidate.acquisitionMethod === "brand_registry" ? "OFFICIAL_MANUFACTURER" : "APPROVED_EXTERNAL_SOURCE",
        usageRights: "internal_only",
        url: fetched.url,
        domain,
        title: extraction.identity.names[0] ?? candidate.title,
        providerKey: candidate.providerKey,
        retrievedAt: new Date(),
        contentSha256: sha256,
        httpStatus: fetched.status,
        robotsAllowed: true,
      })
      .returning({ id: pkbSources.id });

    const [document] = await tx
      .insert(pkbSourceDocuments)
      .values({
        sourceId: source.id,
        pkbProductId: run.pkbProductId,
        runId: run.id,
        status: "retrieved",
        httpStatus: fetched.status,
        contentType: fetched.contentType,
        byteSize: fetched.body.byteLength,
        sha256,
        textContent: extraction.text.slice(0, 200_000),
        structuredData: extraction.structuredData.length > 0 ? extraction.structuredData : null,
        identityMatch: verdict.match,
        identityNotes: verdict.notes,
      })
      .returning({ id: pkbSourceDocuments.id });

    // A page that does not agree with the product's identity is kept as a
    // record and proposes nothing (I-13).
    if (verdict.match !== "match") return { ...empty, retrieved: true };

    const outcome = await proposeFromExtraction(tx, {
      identity,
      extraction,
      sourceId: source.id,
      documentId: document.id,
      runId: run.id,
      actorId: null,
      extractionMethodOf: (pair) => pair.method,
    });
    return { ...outcome, retrieved: true };
  });
}

async function recordRefusal(
  run: RunRow,
  candidate: Candidate,
  domain: string | null,
  reason: string,
  extra: { robotsAllowed?: boolean; httpStatus?: number | null } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const [source] = await tx
      .insert(pkbSources)
      .values({
        sourceType: candidate.sourceType,
        acquisitionMethod: candidate.acquisitionMethod,
        authorityTier: candidate.authorityTier,
        origin: "APPROVED_EXTERNAL_SOURCE",
        usageRights: "unknown",
        url: candidate.url,
        domain,
        providerKey: candidate.providerKey,
        httpStatus: extra.httpStatus ?? null,
        robotsAllowed: extra.robotsAllowed ?? null,
      })
      .returning({ id: pkbSources.id });
    await tx.insert(pkbSourceDocuments).values({
      sourceId: source.id,
      pkbProductId: run.pkbProductId,
      runId: run.id,
      status: "refused",
      refusalReason: reason.slice(0, 300),
      httpStatus: extra.httpStatus ?? null,
    });
  });
  logEvent("info", "pkb.source_refused", { runId: run.id, url: candidate.url, reason });
}

/**
 * Whether a document is about this product. Identifiers decide when the
 * document carries any: a matching GTIN or model number is agreement, a
 * different one of the same kind is disagreement. With none, the brand and a
 * model-like name fragment can agree; anything weaker is `unknown`, which
 * proposes nothing.
 */
export function identityVerdict(
  identity: ProductIdentity,
  extraction: Extraction,
): { match: "match" | "mismatch" | "unknown"; notes: Record<string, unknown> } {
  const notes: Record<string, unknown> = {};
  const ourGtins = new Set(identity.gtins.map((row) => row.gtin14));
  const theirGtins = new Set(
    extraction.identity.gtins
      .map((value) => {
        const normalized = normalizeIdentifier("gtin", value);
        return normalized.validation === "valid" ? normalized.gtin14 : null;
      })
      .filter((value): value is string => value !== null),
  );
  if (ourGtins.size > 0 && theirGtins.size > 0) {
    const shared = [...theirGtins].filter((value) => ourGtins.has(value));
    notes.gtins = { ours: [...ourGtins], theirs: [...theirGtins] };
    return { match: shared.length > 0 ? "match" : "mismatch", notes };
  }

  const ourModels = new Set(identity.modelKeys.map((value) => labelKey(value).replace(/\s+/g, "")));
  const theirModels = new Set(
    [...extraction.identity.mpns, ...extraction.identity.models].map((value) => labelKey(value).replace(/\s+/g, "")),
  );
  if (ourModels.size > 0 && theirModels.size > 0) {
    const shared = [...theirModels].filter((value) => ourModels.has(value));
    notes.models = { ours: [...ourModels], theirs: [...theirModels] };
    return { match: shared.length > 0 ? "match" : "mismatch", notes };
  }

  const ourBrands = new Set(identity.brands.map((brand) => brand.key));
  const theirBrands = new Set(extraction.identity.brands.map((value) => labelKey(value)));
  const brandAgrees = [...theirBrands].some((value) => ourBrands.has(value));
  const nameAgrees =
    ourModels.size > 0 &&
    extraction.identity.names.some((name) => {
      const folded = labelKey(name).replace(/\s+/g, "");
      return [...ourModels].some((model) => model.length >= 4 && folded.includes(model));
    });
  notes.brands = { ours: [...ourBrands], theirs: [...theirBrands] };
  if (brandAgrees && nameAgrees) return { match: "match", notes };
  if (ourBrands.size > 0 && theirBrands.size > 0 && !brandAgrees) return { match: "mismatch", notes };
  return { match: "unknown", notes };
}

/**
 * EXTRACT, NORMALIZE, VALIDATE, PROPOSE for one document. A label an
 * attribute names becomes a claim; a label none names becomes an attribute
 * proposal; a label a person has marked ignored is skipped.
 */
async function proposeFromExtraction(
  tx: Executor,
  input: {
    identity: ProductIdentity;
    extraction: Extraction;
    sourceId: string;
    documentId: string;
    runId: string | null;
    actorId: string | null;
    extractionMethodOf: (pair: Extraction["pairs"][number]) => "structured_data" | "html_table" | "html_text";
  },
): Promise<EnrichmentOutcome> {
  const outcome: EnrichmentOutcome = { claimsProposed: 0, conflicts: 0, proposalsCreated: 0 };
  const [definitions, mappings, family] = await Promise.all([
    loadDefinitions(tx),
    loadLabelMappings(tx),
    tx
      .select({ familyId: pkbProducts.familyId })
      .from(pkbProducts)
      .where(eq(pkbProducts.id, input.identity.pkbProductId))
      .then((rows: { familyId: string | null }[]) => rows[0]?.familyId ?? null),
  ]);

  const usedSlots = new Set<string>();
  for (const pair of input.extraction.pairs.slice(0, MAX_PAIRS_PER_DOCUMENT)) {
    const placed = resolveLabel(definitions, mappings, pair.label, "source_document", family);
    if (placed.kind === "ignored") continue;

    const [evidence] = await tx
      .insert(pkbEvidence)
      .values({
        sourceId: input.sourceId,
        pkbProductId: input.identity.pkbProductId,
        locator: pair.locator,
        excerpt: pair.excerpt.slice(0, 2_000),
        extractionMethod: input.extractionMethodOf(pair),
        extractedLabel: pair.label,
        extractedValue: pair.value,
        extractedUnit: pair.unit,
        documentId: input.documentId,
        createdBy: input.actorId,
      })
      .returning({ id: pkbEvidence.id });

    if (placed.kind === "match") {
      // One value per slot per document: a page repeating a specification
      // does not corroborate itself.
      const slot = `${placed.definition.id}`;
      if (usedSlots.has(slot)) continue;
      usedSlots.add(slot);
      const claim = await createClaim(tx, {
        pkbProductId: input.identity.pkbProductId,
        pkbVariantId: null,
        evidenceId: evidence.id,
        proposedBy: input.actorId,
        proposedByRun: input.runId,
        target: "fact",
        definition: placed.definition,
        raw: pair.value,
        unit: pair.unit,
      });
      outcome.claimsProposed += 1;
      if (claim.status === "CONFLICT") outcome.conflicts += 1;
      continue;
    }

    // An unnamed or ambiguous label is a question for a person, never a guess.
    const proposal = await proposeAttribute(tx, {
      pkbProductId: input.identity.pkbProductId,
      label: pair.label,
      exampleValue: pair.value,
      evidenceId: evidence.id,
      unitHint: pair.unit,
    });
    if (proposal.created) outcome.proposalsCreated += 1;
  }
  return outcome;
}

/**
 * What sources a run would have to read, without reading any of them (D-112).
 *
 * Product preparation asks this before it starts a run, so it can tell a staff
 * member "there is nothing to research yet — give me the manufacturer's page"
 * instead of starting a run that retrieves nothing and completing it as though
 * something had happened.
 *
 * The research provider is asked only when there is nothing else, for two
 * reasons: a configured provider costs a request, and a run that already has
 * the manufacturer's own documentation does not need a search engine's opinion
 * about where else to look. When it is asked, its answer is reported exactly as
 * it came — NOT_CONFIGURED stays NOT_CONFIGURED and is never rounded down to
 * "no sources exist" (A-6).
 */
export type SourceOutlook = {
  /** Pages staff attached to this product, or documents they provided. */
  attached: number;
  /** Addresses the Brand Source Registry can derive from the identifiers. */
  registry: number;
  /** Candidates a research provider offered, when it was asked. */
  discovered: number;
  /** Null when the provider was not asked, because it was not needed. */
  provider: PkbProviderState | null;
};

export async function sourceOutlook(pkbProductId: string): Promise<SourceOutlook> {
  const identity = await loadIdentity(db, pkbProductId);
  if (!identity) throw new PkbError("That product is not in the knowledge base.", 404);

  const brandIds = await trustedBrandIds(db, pkbProductId);
  const registry = await approvedRegistryFor(db, brandIds);
  const preferredDomains = registry
    .filter((entry) => entry.matchKind === "domain" && entry.domain && entry.role !== "blocked")
    .map((entry) => entry.domain!);

  let registryAddresses = 0;
  for (const entry of registry) {
    if (!entry.urlTemplate || entry.role === "blocked") continue;
    registryAddresses += fillTemplate(entry.urlTemplate, identity).length;
  }

  const [attached] = await queryRows<{ total: number }>(
    db,
    sql`select count(*)::int as total
        from pkb_product_sources ps
        join pkb_sources s on s.id = ps.source_id
        where ps.pkb_product_id = ${pkbProductId} and (s.url is not null or s.content_sha256 is not null)`,
  );
  const attachedCount = Number(attached?.total ?? 0);

  if (attachedCount + registryAddresses > 0) {
    return { attached: attachedCount, registry: registryAddresses, discovered: 0, provider: null };
  }

  const provider = getProductResearchProvider();
  const result = await provider.findSources({
    name: identity.name,
    brand: identity.brands[0]?.name ?? null,
    modelNumbers: identity.modelKeys,
    gtins: identity.gtins.map((row) => row.gtin14),
    preferredDomains,
    limit: MAX_CANDIDATES,
  });
  return {
    attached: attachedCount,
    registry: registryAddresses,
    discovered: result.status === "OK" ? result.candidates.length : 0,
    provider: {
      provider: provider.key,
      status: result.status,
      message: result.status === "OK" ? `${result.candidates.length} candidate pages` : result.message,
    },
  };
}

// ---------------------------------------------------------------- reading

/** The runs of one product, newest first, for the Product Intelligence view. */
export async function enrichmentRuns(executor: Executor, pkbProductId: string, limit = 10): Promise<RunRow[]> {
  return executor
    .select()
    .from(pkbEnrichmentRuns)
    .where(eq(pkbEnrichmentRuns.pkbProductId, pkbProductId))
    .orderBy(desc(pkbEnrichmentRuns.createdAt))
    .limit(limit);
}

export type SourceDocumentView = {
  id: string;
  status: "retrieved" | "provided" | "refused" | "failed";
  refusalReason: string | null;
  identityMatch: "match" | "mismatch" | "unknown" | "not_checked";
  url: string | null;
  domain: string | null;
  title: string | null;
  sourceType: string;
  authorityTier: number | null;
  httpStatus: number | null;
  retrievedAt: Date;
};

export async function sourceDocuments(executor: Executor, pkbProductId: string, limit = 50): Promise<SourceDocumentView[]> {
  return executor
    .select({
      id: pkbSourceDocuments.id,
      status: pkbSourceDocuments.status,
      refusalReason: pkbSourceDocuments.refusalReason,
      identityMatch: pkbSourceDocuments.identityMatch,
      url: pkbSources.url,
      domain: pkbSources.domain,
      title: pkbSources.title,
      sourceType: pkbSources.sourceType,
      authorityTier: pkbSources.authorityTier,
      httpStatus: pkbSourceDocuments.httpStatus,
      retrievedAt: pkbSourceDocuments.retrievedAt,
    })
    .from(pkbSourceDocuments)
    .innerJoin(pkbSources, eq(pkbSources.id, pkbSourceDocuments.sourceId))
    .where(eq(pkbSourceDocuments.pkbProductId, pkbProductId))
    .orderBy(desc(pkbSourceDocuments.retrievedAt))
    .limit(limit);
}

/** A run the job runner should pick up, by id. */
export async function pendingRun(runId: string): Promise<RunRow | undefined> {
  const [run] = await db
    .select()
    .from(pkbEnrichmentRuns)
    .where(and(eq(pkbEnrichmentRuns.id, runId), eq(pkbEnrichmentRuns.status, "queued")));
  return run;
}
