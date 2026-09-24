import { PREPARATION_CODES, PREPARATION_STEPS, STEP_STAGE } from "./types";
import type { PreparationNote, PreparationStage, PreparationStep, PreparationStepRecord } from "./types";

/**
 * Product preparation, in the words a staff member uses (D-116).
 *
 * The backend's vocabulary is accurate and internal: a stage called
 * `PREPARING_SEARCH`, a code called `AUTOMATIC_SOURCE_DISCOVERY_NOT_CONFIGURED`,
 * a note whose remedy assumes the reader knows what the Brand Source Registry
 * is. None of that belongs on the screen a new product-entry employee uses on
 * their first morning, and none of it is changed here: this module is a
 * translation layer over the existing run view, and it invents no state of its
 * own.
 *
 * Two rules hold it together. Every label describes work that genuinely
 * happened — a step is shown as finished only when the run recorded it as
 * finished, so there is no fabricated progress and no percentage. And every
 * issue shown to a person comes from a note the backend actually returned: an
 * unknown code still renders, using the backend's own message, rather than
 * being hidden because this file has not heard of it.
 */

/** The stage headline, for the one progress surface. */
export const STAGE_LABEL: Record<PreparationStage, string> = {
  IDENTIFYING: "Identifying product",
  FINDING_SOURCES: "Finding trusted sources",
  RESEARCHING: "Collecting product information",
  VERIFYING: "Checking product information",
  NEEDS_REVIEW: "Needs your attention",
  PREPARING_CONTENT: "Preparing product content",
  PREPARING_SEARCH: "Preparing search",
  CHECKING_PAGE: "Checking product page",
  READY: "Ready",
  FAILED: "Preparation stopped",
  BLOCKED: "Preparation cannot continue yet",
  CANCELLED: "Preparation cancelled",
};

/** One line under the headline, saying what is happening or what to do. */
export const STAGE_SUMMARY: Record<PreparationStage, string> = {
  IDENTIFYING: "Working out exactly which product this is.",
  FINDING_SOURCES: "Looking for pages and documents that describe it.",
  RESEARCHING: "Reading what those sources say about the product.",
  VERIFYING: "Comparing what the sources say against what is already recorded.",
  NEEDS_REVIEW: "A few things need a decision before this can go on.",
  PREPARING_CONTENT: "Writing the description, key features and search wording.",
  PREPARING_SEARCH: "Making sure the product can be found in search.",
  CHECKING_PAGE: "Checking the product page is ready for shoppers.",
  READY: "SeoPulse has finished. Add your price, stock and photographs below.",
  FAILED: "Something went wrong. Nothing about the product was changed.",
  BLOCKED: "SeoPulse needs something from you before it can carry on.",
  CANCELLED: "You stopped this. Start it again whenever you are ready.",
};

/** What each step of the sequence is called on screen, once it is finished. */
export const STEP_LABEL: Record<PreparationStep, string> = {
  identity: "Product identified",
  sources: "Sources found",
  enrichment: "Product information collected",
  verification: "Product information checked",
  content: "Product content prepared",
  search: "Search prepared",
  page: "Product page checked",
};

const FINISHED = new Set<PreparationStage>(["READY", "FAILED", "BLOCKED", "CANCELLED"]);

export type PhaseState = "done" | "partial" | "active" | "pending";

export type PreparationPhase = {
  key: PreparationStep;
  label: string;
  state: PhaseState;
  /** The run's own account of the step, where it has one. */
  detail: string | null;
};

/**
 * The checklist, from the run's recorded steps and its current stage.
 *
 * A step is `done` only when the run wrote a record for it. Exactly one step
 * may be `active`, and only while the run is still moving: a stopped run shows
 * the step it stopped on as pending, because nothing is working on it.
 */
export function preparationPhases(
  stage: PreparationStage,
  steps: PreparationStepRecord[],
): PreparationPhase[] {
  const records = new Map(steps.map((step) => [step.key, step]));
  const moving = !FINISHED.has(stage) && stage !== "NEEDS_REVIEW";
  let activeAssigned = false;

  return PREPARATION_STEPS.map((key) => {
    const record = records.get(key);
    if (record) {
      return {
        key,
        label: STEP_LABEL[key],
        // "degraded" and "skipped" are honest about a step that finished
        // without doing all of its work — a research run that read nothing,
        // a search index still catching up.
        state: record.state === "done" ? ("done" as const) : ("partial" as const),
        detail: record.detail || null,
      };
    }
    const isActive = moving && !activeAssigned && STEP_STAGE[key] === stage;
    if (isActive) activeAssigned = true;
    return {
      key,
      label: STEP_LABEL[key],
      state: isActive ? ("active" as const) : ("pending" as const),
      detail: null,
    };
  });
}

/** Whether the screen should keep asking the server about this run. */
export function shouldKeepPolling(stage: PreparationStage): boolean {
  return !FINISHED.has(stage) && stage !== "NEEDS_REVIEW";
}

export type IssueAction =
  /** Ask for the manufacturer's identity fields, then continue the run. */
  | "identity"
  /** Ask for an address or a pasted specification, then continue the run. */
  | "sources"
  /** Open Product Intelligence, where the decision is actually taken. */
  | "intelligence"
  /** Jump to the specifications panel of this editor. */
  | "specifications"
  /** Ask the run to check again, with nothing new supplied. */
  | "recheck"
  /** Run the whole thing again from where it stopped. */
  | "retry"
  /** Leave preparation and finish the product by hand. */
  | "manual";

export type PreparationIssue = {
  code: string;
  /** A short heading a person can scan. Never a code. */
  title: string;
  /** What happened, from the backend's own note. */
  message: string;
  /** What to do about it, from the backend's own note. */
  remedy: string;
  actions: IssueAction[];
};

/** Headings and offered actions per code. Unknown codes fall through. */
const ISSUE_SHAPE: Record<string, { title: string; actions: IssueAction[] }> = {
  [PREPARATION_CODES.IDENTITY_UNRESOLVED]: {
    title: "SeoPulse needs to know which product this is",
    actions: ["identity", "manual"],
  },
  [PREPARATION_CODES.IDENTITY_AMBIGUOUS]: {
    title: "We could not safely identify the exact version",
    actions: ["identity", "intelligence"],
  },
  [PREPARATION_CODES.NO_SOURCES]: {
    title: "SeoPulse needs a product source",
    actions: ["sources", "manual"],
  },
  [PREPARATION_CODES.AUTOMATIC_SOURCE_DISCOVERY_NOT_CONFIGURED]: {
    title: "SeoPulse needs a product source",
    actions: ["sources", "manual"],
  },
  [PREPARATION_CODES.AUTOMATIC_SOURCE_DISCOVERY_UNAVAILABLE]: {
    title: "SeoPulse needs a product source",
    actions: ["sources", "manual"],
  },
  [PREPARATION_CODES.ENRICHMENT_BLOCKED]: {
    title: "Research could not start for this product",
    actions: ["identity", "intelligence"],
  },
  [PREPARATION_CODES.ENRICHMENT_FAILED]: {
    title: "Research did not finish",
    actions: ["retry", "manual"],
  },
  [PREPARATION_CODES.CLAIMS_CONFLICT]: {
    title: "Two sources disagree",
    actions: ["intelligence", "recheck"],
  },
  [PREPARATION_CODES.CLAIMS_WAITING]: {
    title: "Researched information is waiting for you",
    actions: ["intelligence", "recheck"],
  },
  [PREPARATION_CODES.LABELS_WAITING]: {
    title: "Some information has no name yet",
    actions: ["intelligence", "recheck"],
  },
  [PREPARATION_CODES.INSUFFICIENT_KNOWLEDGE]: {
    title: "SeoPulse needs more product information",
    actions: ["sources", "specifications", "recheck"],
  },
  [PREPARATION_CODES.CONTENT_PROVIDER_UNAVAILABLE]: {
    title: "The content could not be written just now",
    actions: ["retry", "manual"],
  },
  [PREPARATION_CODES.CONTENT_FAILED]: {
    title: "The content could not be written",
    actions: ["retry", "manual"],
  },
  [PREPARATION_CODES.SEARCH_INDEX_LAGGING]: {
    title: "Search is still catching up",
    actions: ["recheck"],
  },
  [PREPARATION_CODES.PRODUCT_REMOVED]: {
    title: "This product is no longer available",
    actions: [],
  },
  [PREPARATION_CODES.TOO_LONG]: {
    title: "Preparation took too long",
    actions: ["retry", "manual"],
  },
  [PREPARATION_CODES.CANCELLED]: {
    title: "Preparation was cancelled",
    actions: ["retry"],
  },
};

/**
 * One backend note as an issue a person can act on.
 *
 * The message and the remedy are the backend's, word for word. Only the
 * heading and the set of buttons are decided here, so a note this file has
 * never seen still reaches the screen with something useful on it.
 */
export function describeIssue(note: PreparationNote): PreparationIssue {
  const shape = ISSUE_SHAPE[note.code];
  return {
    code: note.code,
    title: shape?.title ?? "This needs your attention",
    message: note.message,
    remedy: note.remedy,
    actions: shape?.actions ?? ["retry", "manual"],
  };
}

/** "2 things need your attention", or the singular of it. */
export function attentionSummary(count: number): string {
  return count === 1 ? "1 thing needs your attention" : `${count} things need your attention`;
}

/**
 * How settled the product's identity is, without the vocabulary.
 *
 * `VERIFIED` and `HIGH_CONFIDENCE` are the two states research is allowed to
 * run from, so both read as identified; the difference between them matters to
 * whoever is deciding trust policy, and that is a Product Intelligence
 * question. What a product-entry employee needs from this line is whether they
 * have to type something.
 */
export function describeIdentityState(
  state: "VERIFIED" | "HIGH_CONFIDENCE" | "AMBIGUOUS" | "UNRESOLVED" | null,
): { label: string; tone: "good" | "warn" | "plain"; detail: string } {
  switch (state) {
    case "VERIFIED":
      return { label: "Identified", tone: "good", detail: "Someone confirmed which product this is." };
    case "HIGH_CONFIDENCE":
      return { label: "Identified", tone: "good", detail: "The brand and identifiers match one product." };
    case "AMBIGUOUS":
      return {
        label: "Needs review",
        tone: "warn",
        detail: "More than one product matches what is recorded here.",
      };
    case "UNRESOLVED":
      return {
        label: "Needs information",
        tone: "warn",
        detail: "Add a model number, part number or barcode so research can run.",
      };
    default:
      return { label: "Not identified yet", tone: "plain", detail: "Nothing has been researched for this product." };
  }
}

/**
 * Whether automatic source discovery is available, in words staff care about.
 *
 * Which service implements it is an administrator's concern and stays on the
 * administrator's screens; what a product-entry employee needs to know is
 * whether they will have to supply the manufacturer's page themselves.
 */
export function describeDiscovery(configured: boolean): {
  available: boolean;
  label: string;
  hint: string;
} {
  return configured
    ? {
        available: true,
        label: "Automatic source discovery available",
        hint: "Manifest can usually find the manufacturer's page on its own. Giving one below still makes it faster and more accurate.",
      }
    : {
        available: false,
        label: "Automatic source discovery is not configured",
        hint: "Add the official product page, or paste the specification, so SeoPulse has something to research from.",
      };
}
