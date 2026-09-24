/**
 * The Product Knowledge Base (docs/KNOWLEDGE_PLATFORM.md, D-060 to D-070).
 *
 * The only code that writes `pkb_*` tables. Storefront, SeoPulse and
 * SearchPulse read knowledge through what this module exports; they propose,
 * this module decides.
 */
export * from "./common";
export { exportEligibility, type ExportDecision } from "./export";
export {
  activateFamilyVersion,
  approveFamily,
  assignFamily,
  draftFamilyVersion,
  rejectFamily,
  resolveFamilySchema,
  suggestFamily,
  syncLegacyFamilies,
  type FamilySchemaAttribute,
} from "./families";
export {
  clearFact,
  completenessOf,
  effectiveFactState,
  getProductKnowledge,
  lockFact,
  setFact,
  unlockFact,
  type Completeness,
  type ProductKnowledgeView,
  type SlotState,
  type SlotView,
} from "./facts";
export { listClaims, proposeFactClaim, recordEvidence, recordSource } from "./evidence";
export { decideAlias, suggestAlias } from "./aliases";
export {
  classifyParkedValues,
  legacyCoverage,
  listingKeywordMigration,
  suggestAliasesFromKeywords,
  PARKED_CLASSES,
  type LegacyCoverage,
  type LegacySystemCoverage,
  type ParkedClass,
  type ParkedValueGroup,
  type ParkedValueReport,
} from "./legacy-coverage";
export { addRelationship, listRelationships, removeRelationship } from "./relationships";
export {
  backfillKnowledge,
  knowledgeReport,
  releaseListingKnowledge,
  runKnowledgeSync,
  type KnowledgeReport,
} from "./maintenance";
export { beginListingChange, processKnowledgeQueue, syncListingKnowledge } from "./sync";
export { ensureSystemVocabulary, SYSTEM_DEFINITIONS } from "./vocabulary";
