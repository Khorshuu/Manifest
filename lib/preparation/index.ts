/**
 * Product preparation (docs/KNOWLEDGE_PLATFORM.md section 3H, D-112).
 *
 * The orchestration layer behind one staff action — research and prepare this
 * product — built entirely out of the systems that already exist. It owns no
 * facts, no claims, no evidence and no wording; it owns the order things
 * happen in, and the record of how far they got.
 */
export {
  cancelPreparation,
  continuePreparation,
  getPreparation,
  getPreparationRun,
  listPreparationRuns,
  preparationSummary,
  retryPreparation,
  startPreparation,
  PREPARATION_JOB,
  type PreparationRunRow,
  type StartPreparationInput,
} from "./service";
export { advancePreparation, stalePreparationRuns } from "./runner";
export { productResearchStatus } from "./research-status";
export {
  attentionSummary,
  describeDiscovery,
  describeIdentityState,
  describeIssue,
  describeResearchStatus,
  preparationPhases,
  shouldKeepPolling,
  STAGE_LABEL,
  STAGE_SUMMARY,
  STEP_LABEL,
  type IssueAction,
  type PhaseState,
  type PreparationIssue,
  type PreparationPhase,
  type ResearchStatus,
} from "./presentation";
export {
  FINISHED_STAGES,
  PREPARATION_CODES,
  PREPARATION_STEPS,
  STEP_STAGE,
  type PreparationCode,
  type PreparationNote,
  type PreparationStage,
  type PreparationStep,
  type PreparationStepRecord,
  type PreparationView,
} from "./types";
