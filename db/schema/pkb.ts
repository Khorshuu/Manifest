import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { categories, categoryAttributes, products } from "./catalog";
import { users } from "./users";
import { productVariants } from "./variants";

/**
 * The Product Knowledge Base (docs/KNOWLEDGE_PLATFORM.md, D-060 to D-070).
 *
 * db/migrations/0031_product_knowledge_base.sql is the source of truth for these
 * tables: its check constraints, domains and triggers enforce the verification,
 * provenance and schema-versioning rules. The declarations here let `lib/pkb`
 * read and write the tables through Drizzle; nothing outside `lib/pkb` should.
 */

export const PKB_ORIGINS = [
  "MANIFEST_CREATED",
  "MANUAL_ADMIN",
  "OFFICIAL_MANUFACTURER",
  "APPROVED_EXTERNAL_SOURCE",
  "SUPPLIER_PROVIDED",
  "PROVIDER_RESTRICTED",
  "CUSTOMER_DERIVED",
  "UNKNOWN_LEGACY",
] as const;
export type PkbOrigin = (typeof PKB_ORIGINS)[number];

/** Stored on accepted facts, identifiers and relationships. */
export const PKB_VERIFICATION_STATES = ["VERIFIED", "MANUAL", "UNVERIFIED", "LEGACY"] as const;
export type PkbVerificationState = (typeof PKB_VERIFICATION_STATES)[number];

export const PKB_REVIEW_STATUSES = ["suggested", "approved", "retired"] as const;
export type PkbReviewStatus = (typeof PKB_REVIEW_STATUSES)[number];

export const PKB_VALUE_STATUSES = ["normalized", "unnormalized", "not_applicable"] as const;
export type PkbValueStatus = (typeof PKB_VALUE_STATUSES)[number];

export const PKB_CLAIM_STATUSES = ["SUGGESTED", "CONFLICT", "ACCEPTED", "REJECTED", "SUPERSEDED"] as const;
export type PkbClaimStatus = (typeof PKB_CLAIM_STATUSES)[number];

export const PKB_SOURCE_TYPES = [
  "manufacturer_website",
  "manufacturer_documentation",
  "manufacturer_support",
  "manufacturer_feed",
  "authorized_distributor",
  "retailer",
  "product_database",
  "supplier_feed",
  "supplier_document",
  "admin_official_document",
  "staff_entry",
  "public_web",
  "research_provider",
  "legacy_import",
  "other",
] as const;
export type PkbSourceType = (typeof PKB_SOURCE_TYPES)[number];

export const PKB_ACQUISITION_METHODS = [
  "brand_registry",
  "staff_url",
  "staff_upload",
  "staff_entry",
  "manufacturer_feed",
  "supplier_feed",
  "public_mechanism",
  "research_provider",
  "legacy_import",
  "system",
] as const;
export type PkbAcquisitionMethod = (typeof PKB_ACQUISITION_METHODS)[number];

export const PKB_USAGE_RIGHTS = ["internal_only", "display", "exportable", "unknown"] as const;
export type PkbUsageRights = (typeof PKB_USAGE_RIGHTS)[number];

export const PKB_EXTRACTION_METHODS = [
  "manual",
  "structured_data",
  "html_table",
  "html_text",
  "pdf_text",
  "feed_field",
  "rule",
  "ai_assisted",
  "legacy_import",
] as const;
export type PkbExtractionMethod = (typeof PKB_EXTRACTION_METHODS)[number];

export const PKB_RELATIONSHIP_KINDS = [
  "accessory_for",
  "compatible_with",
  "successor_of",
  "replacement_for",
  "bundle_contains",
  "requires",
  "related_to",
  "same_series",
] as const;
export type PkbRelationshipKind = (typeof PKB_RELATIONSHIP_KINDS)[number];

export const PKB_ALIAS_KINDS = [
  "spelling_variant",
  "abbreviation",
  "model_formatting",
  "common_name",
  "former_name",
  "misspelling",
  "translation",
  "other",
] as const;
export type PkbAliasKind = (typeof PKB_ALIAS_KINDS)[number];

export const PKB_UNMAPPED_REASONS = [
  "no_matching_definition",
  "ambiguous_label",
  "multi_value_label",
  "option_without_definition",
  "duplicate_of_structured_value",
  "conflicts_with_structured_value",
  "differs_from_knowledge_value",
  "identifier_in_use",
  "invalid_identifier",
  "unattributed_change_not_applied",
  "differs_from_locked_value",
] as const;
export type PkbUnmappedReason = (typeof PKB_UNMAPPED_REASONS)[number];

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const pkbBrands = pgTable("pkb_brands", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  nameNormalized: text("name_normalized").notNull().unique(),
  slug: text("slug").notNull().unique(),
  status: text("status").$type<PkbReviewStatus>().notNull().default("suggested"),
  origin: text("origin").$type<PkbOrigin>().notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  ...timestamps,
});

export const pkbAttributeDefinitions = pgTable("pkb_attribute_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  description: text("description"),
  dataType: text("data_type").notNull(),
  cardinality: text("cardinality").$type<"single" | "multiple">().notNull().default("single"),
  unitDimension: text("unit_dimension"),
  displayUnit: text("display_unit"),
  /** { min?, max?, maxLength?, pattern? } — small, bounded configuration. */
  validation: jsonb("validation"),
  searchable: boolean("searchable").notNull().default(false),
  filterable: boolean("filterable").notNull().default(false),
  seoRelevant: boolean("seo_relevant").notNull().default(false),
  structuredDataProperty: text("structured_data_property"),
  isSystem: boolean("is_system").notNull().default(false),
  status: text("status").$type<PkbReviewStatus>().notNull().default("suggested"),
  origin: text("origin").$type<PkbOrigin>().notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  ...timestamps,
});

export const pkbAttributeOptions = pgTable(
  "pkb_attribute_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => pkbAttributeDefinitions.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status").$type<PkbReviewStatus>().notNull().default("approved"),
    origin: text("origin").$type<PkbOrigin>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("pkb_attribute_options_key_unique").on(table.definitionId, table.key)],
);

export const pkbFamilies = pgTable("pkb_families", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  parentId: uuid("parent_id"),
  status: text("status").$type<PkbReviewStatus>().notNull().default("suggested"),
  origin: text("origin").$type<PkbOrigin>().notNull(),
  legacyCategoryId: uuid("legacy_category_id").references(() => categories.id, { onDelete: "set null" }),
  suggestedBy: uuid("suggested_by").references(() => users.id),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  ...timestamps,
});

export const PKB_FAMILY_VERSION_STATUSES = ["draft", "active", "retired"] as const;
export type PkbFamilyVersionStatus = (typeof PKB_FAMILY_VERSION_STATUSES)[number];

export const pkbFamilyVersions = pgTable(
  "pkb_family_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => pkbFamilies.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").$type<PkbFamilyVersionStatus>().notNull().default("draft"),
    changeNote: text("change_note"),
    createdBy: uuid("created_by").references(() => users.id),
    activatedBy: uuid("activated_by").references(() => users.id),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("pkb_family_versions_version_unique").on(table.familyId, table.version)],
);

export const PKB_REQUIREMENTS = ["required", "recommended", "optional"] as const;
export type PkbRequirement = (typeof PKB_REQUIREMENTS)[number];

export const pkbFamilyAttributes = pgTable(
  "pkb_family_attributes",
  {
    familyVersionId: uuid("family_version_id")
      .notNull()
      .references(() => pkbFamilyVersions.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => pkbAttributeDefinitions.id),
    requirement: text("requirement").$type<PkbRequirement>().notNull().default("optional"),
    variantDefining: boolean("variant_defining").notNull().default(false),
    searchable: boolean("searchable"),
    filterable: boolean("filterable"),
    seoRelevant: boolean("seo_relevant"),
    groupLabel: text("group_label"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.familyVersionId, table.definitionId] })],
);

export const pkbProducts = pgTable(
  "pkb_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    nameSource: text("name_source").$type<"listing_title" | "manual">().notNull().default("listing_title"),
    familyId: uuid("family_id").references(() => pkbFamilies.id),
    familyAssignment: text("family_assignment")
      .$type<"assigned" | "suggested" | "unassigned">()
      .notNull()
      .default("unassigned"),
    familyAssignmentSource: text("family_assignment_source").$type<"legacy_category" | "manual" | "resolution">(),
    resolutionState: text("resolution_state")
      .$type<"VERIFIED" | "HIGH_CONFIDENCE" | "AMBIGUOUS" | "UNRESOLVED">()
      .notNull()
      .default("UNRESOLVED"),
    status: text("status").$type<"active" | "merged" | "retired">().notNull().default("active"),
    mergedIntoId: uuid("merged_into_id"),
    origin: text("origin").$type<PkbOrigin>().notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (table) => [index("pkb_products_family_idx").on(table.familyId)],
);

export const pkbVariants = pgTable(
  "pkb_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pkbProductId: uuid("pkb_product_id")
      .notNull()
      .references(() => pkbProducts.id, { onDelete: "cascade" }),
    status: text("status").$type<"active" | "retired">().notNull().default("active"),
    origin: text("origin").$type<PkbOrigin>().notNull(),
    ...timestamps,
  },
  (table) => [index("pkb_variants_product_idx").on(table.pkbProductId)],
);

export const pkbSources = pgTable("pkb_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceKey: text("source_key").unique(),
  sourceType: text("source_type").$type<PkbSourceType>().notNull(),
  acquisitionMethod: text("acquisition_method").$type<PkbAcquisitionMethod>().notNull(),
  authorityTier: smallint("authority_tier"),
  origin: text("origin").$type<PkbOrigin>().notNull(),
  usageRights: text("usage_rights").$type<PkbUsageRights>().notNull().default("unknown"),
  url: text("url"),
  urlNormalized: text("url_normalized"),
  domain: text("domain"),
  title: text("title"),
  providerKey: text("provider_key"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
  contentSha256: text("content_sha256"),
  httpStatus: smallint("http_status"),
  robotsAllowed: boolean("robots_allowed"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pkbEvidence = pgTable("pkb_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => pkbSources.id),
  pkbProductId: uuid("pkb_product_id")
    .notNull()
    .references(() => pkbProducts.id, { onDelete: "cascade" }),
  locator: text("locator"),
  excerpt: text("excerpt"),
  extractionMethod: text("extraction_method").$type<PkbExtractionMethod>().notNull(),
  extractedLabel: text("extracted_label"),
  extractedValue: text("extracted_value"),
  extractedUnit: text("extracted_unit"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The typed value columns shared by facts and claims. */
const valueColumns = {
  valueStatus: text("value_status").$type<PkbValueStatus>().notNull(),
  rawValue: text("raw_value"),
  rawUnit: text("raw_unit"),
  valueText: text("value_text"),
  valueNumber: numeric("value_number"),
  valueNumberMax: numeric("value_number_max"),
  valueUnit: text("value_unit"),
  valueBoolean: boolean("value_boolean"),
  valueDate: date("value_date", { mode: "string" }),
  valueOptionId: uuid("value_option_id"),
  valueBrandId: uuid("value_brand_id").references(() => pkbBrands.id),
};

export const pkbClaims = pgTable(
  "pkb_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pkbProductId: uuid("pkb_product_id")
      .notNull()
      .references(() => pkbProducts.id, { onDelete: "cascade" }),
    pkbVariantId: uuid("pkb_variant_id"),
    targetKind: text("target_kind").$type<"fact" | "identifier">().notNull(),
    definitionId: uuid("definition_id").references(() => pkbAttributeDefinitions.id),
    identifierType: text("identifier_type"),
    ordinal: smallint("ordinal").notNull().default(0),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => pkbEvidence.id),
    ...valueColumns,
    identifierNormalized: text("identifier_normalized"),
    status: text("status").$type<PkbClaimStatus>().notNull().default("SUGGESTED"),
    proposedBy: uuid("proposed_by").references(() => users.id),
    proposedByRun: text("proposed_by_run"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decisionPolicy: text("decision_policy"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    ...timestamps,
  },
  (table) => [index("pkb_claims_product_status_idx").on(table.pkbProductId, table.status)],
);

export const pkbFacts = pgTable(
  "pkb_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pkbProductId: uuid("pkb_product_id")
      .notNull()
      .references(() => pkbProducts.id, { onDelete: "cascade" }),
    pkbVariantId: uuid("pkb_variant_id"),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => pkbAttributeDefinitions.id),
    ordinal: smallint("ordinal").notNull().default(0),
    ...valueColumns,
    rawLabel: text("raw_label"),
    verificationState: text("verification_state").$type<PkbVerificationState>().notNull(),
    origin: text("origin").$type<PkbOrigin>().notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => pkbSources.id),
    claimId: uuid("claim_id").references(() => pkbClaims.id),
    decidedBy: uuid("decided_by").references(() => users.id),
    decisionPolicy: text("decision_policy"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by").references(() => users.id),
    legacyRef: text("legacy_ref"),
    ...timestamps,
  },
  (table) => [
    unique("pkb_facts_slot_unique")
      .on(table.pkbProductId, table.pkbVariantId, table.definitionId, table.ordinal)
      .nullsNotDistinct(),
  ],
);

export const PKB_HISTORY_CHANGES = ["created", "updated", "cleared", "locked", "unlocked", "restored"] as const;
export type PkbHistoryChange = (typeof PKB_HISTORY_CHANGES)[number];

export const pkbFactHistory = pgTable("pkb_fact_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  factId: uuid("fact_id").notNull(),
  pkbProductId: uuid("pkb_product_id")
    .notNull()
    .references(() => pkbProducts.id, { onDelete: "cascade" }),
  pkbVariantId: uuid("pkb_variant_id"),
  definitionId: uuid("definition_id")
    .notNull()
    .references(() => pkbAttributeDefinitions.id),
  changeKind: text("change_kind").$type<PkbHistoryChange>().notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pkbIdentifiers = pgTable("pkb_identifiers", {
  id: uuid("id").primaryKey().defaultRandom(),
  pkbProductId: uuid("pkb_product_id")
    .notNull()
    .references(() => pkbProducts.id, { onDelete: "cascade" }),
  pkbVariantId: uuid("pkb_variant_id"),
  identifierType: text("identifier_type").notNull(),
  valueRaw: text("value_raw").notNull(),
  valueNormalized: text("value_normalized"),
  gtin14: text("gtin14"),
  validationStatus: text("validation_status").$type<"valid" | "invalid" | "unchecked">().notNull(),
  verificationState: text("verification_state").$type<PkbVerificationState>().notNull(),
  origin: text("origin").$type<PkbOrigin>().notNull(),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => pkbSources.id),
  claimId: uuid("claim_id").references(() => pkbClaims.id),
  decidedBy: uuid("decided_by").references(() => users.id),
  decisionPolicy: text("decision_policy"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: uuid("locked_by").references(() => users.id),
  legacyRef: text("legacy_ref"),
  ...timestamps,
});

export const pkbRelationships = pgTable(
  "pkb_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromProductId: uuid("from_product_id")
      .notNull()
      .references(() => pkbProducts.id, { onDelete: "cascade" }),
    toProductId: uuid("to_product_id")
      .notNull()
      .references(() => pkbProducts.id, { onDelete: "cascade" }),
    kind: text("kind").$type<PkbRelationshipKind>().notNull(),
    verificationState: text("verification_state").$type<PkbVerificationState>().notNull(),
    origin: text("origin").$type<PkbOrigin>().notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => pkbSources.id),
    claimId: uuid("claim_id").references(() => pkbClaims.id),
    decidedBy: uuid("decided_by").references(() => users.id),
    decisionPolicy: text("decision_policy"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by").references(() => users.id),
    note: text("note"),
    ...timestamps,
  },
  (table) => [unique("pkb_relationships_unique").on(table.fromProductId, table.toProductId, table.kind)],
);

export const PKB_ALIAS_TARGETS = ["brand", "product", "variant", "family", "definition", "option"] as const;
export type PkbAliasTarget = (typeof PKB_ALIAS_TARGETS)[number];

export const pkbAliases = pgTable("pkb_aliases", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetKind: text("target_kind").$type<PkbAliasTarget>().notNull(),
  brandId: uuid("brand_id").references(() => pkbBrands.id, { onDelete: "cascade" }),
  pkbProductId: uuid("pkb_product_id").references(() => pkbProducts.id, { onDelete: "cascade" }),
  pkbVariantId: uuid("pkb_variant_id").references(() => pkbVariants.id, { onDelete: "cascade" }),
  familyId: uuid("family_id").references(() => pkbFamilies.id, { onDelete: "cascade" }),
  definitionId: uuid("definition_id").references(() => pkbAttributeDefinitions.id, { onDelete: "cascade" }),
  optionId: uuid("option_id"),
  alias: text("alias").notNull(),
  aliasNormalized: text("alias_normalized").notNull(),
  aliasKind: text("alias_kind").$type<PkbAliasKind>().notNull(),
  status: text("status").$type<"suggested" | "approved" | "rejected">().notNull().default("suggested"),
  origin: text("origin").$type<PkbOrigin>().notNull(),
  sourceId: uuid("source_id").references(() => pkbSources.id),
  evidenceNote: text("evidence_note"),
  createdBy: uuid("created_by").references(() => users.id),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pkbLegacyAttributeMap = pgTable("pkb_legacy_attribute_map", {
  categoryAttributeId: uuid("category_attribute_id")
    .primaryKey()
    .references(() => categoryAttributes.id, { onDelete: "cascade" }),
  definitionId: uuid("definition_id")
    .notNull()
    .references(() => pkbAttributeDefinitions.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pkbUnmappedValues = pgTable(
  "pkb_unmapped_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    legacyRef: text("legacy_ref").notNull(),
    label: text("label"),
    value: text("value").notNull(),
    entryKey: text("entry_key").notNull(),
    reason: text("reason").$type<PkbUnmappedReason>().notNull(),
    status: text("status").$type<"open" | "dismissed">().notNull().default("open"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [unique("pkb_unmapped_values_entry_unique").on(table.productId, table.entryKey)],
);

export const pkbSyncQueue = pgTable("pkb_sync_queue", {
  productId: uuid("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimedBy: text("claimed_by"),
  lastError: text("last_error"),
});
