/**
 * Product preparation, as the staff screen reads it (D-116).
 *
 * The screen itself is a React component and is exercised end to end in
 * `e2e/product-preparation.spec.ts`. What is asserted here is the part that
 * decides what the screen says: which stage maps to which sentence, which
 * recorded steps count as finished, and which buttons a backend note earns.
 *
 * The rules under test are the ones that would quietly become lies if they
 * broke. Progress is never invented — a step is shown as finished only when
 * the run recorded it. Polling stops the moment a run is finished or waiting
 * for a person, so a browser left open overnight is not asking the server for
 * a run that will never move. And an unknown code still reaches the screen
 * with the backend's own words on it, rather than being swallowed because
 * this translation layer has not been taught about it yet.
 */
import { describe, expect, it } from "vitest";
import { PREPARATION_STAGES, type PreparationStepRecord } from "@/db/schema";
import {
  attentionSummary,
  describeDiscovery,
  describeIdentityState,
  describeIssue,
  preparationPhases,
  shouldKeepPolling,
  STAGE_LABEL,
  STAGE_SUMMARY,
} from "@/lib/preparation/presentation";
import { PREPARATION_CODES, PREPARATION_STEPS } from "@/lib/preparation/types";

const step = (key: string, state: PreparationStepRecord["state"] = "done"): PreparationStepRecord => ({
  key,
  state,
  detail: `${key} finished`,
  at: new Date().toISOString(),
});

describe("stage wording", () => {
  it("gives every backend stage a sentence, and never shows the code itself", () => {
    for (const stage of PREPARATION_STAGES) {
      const label = STAGE_LABEL[stage];
      const summary = STAGE_SUMMARY[stage];
      expect(label, stage).toBeTruthy();
      expect(summary, stage).toBeTruthy();
      expect(label).not.toContain("_");
      expect(label).not.toBe(stage);
      expect(summary).not.toContain("_");
    }
  });
});

describe("polling", () => {
  it("keeps asking only while the run is expected to move on its own", () => {
    expect(shouldKeepPolling("IDENTIFYING")).toBe(true);
    expect(shouldKeepPolling("RESEARCHING")).toBe(true);
    expect(shouldKeepPolling("PREPARING_SEARCH")).toBe(true);
    for (const stopped of ["READY", "NEEDS_REVIEW", "BLOCKED", "FAILED", "CANCELLED"] as const) {
      expect(shouldKeepPolling(stopped), stopped).toBe(false);
    }
  });
});

describe("the progress checklist", () => {
  it("shows nothing as finished until the run has recorded it", () => {
    const phases = preparationPhases("IDENTIFYING", []);
    expect(phases).toHaveLength(PREPARATION_STEPS.length);
    expect(phases.filter((phase) => phase.state === "done")).toHaveLength(0);
    expect(phases[0].state).toBe("active");
    expect(phases.slice(1).every((phase) => phase.state === "pending")).toBe(true);
  });

  it("marks exactly one step active, and only while the run is moving", () => {
    const phases = preparationPhases("RESEARCHING", [step("identity"), step("sources")]);
    const active = phases.filter((phase) => phase.state === "active");
    expect(active).toHaveLength(1);
    expect(active[0].key).toBe("enrichment");
    expect(phases[0].state).toBe("done");
    expect(phases[1].state).toBe("done");
  });

  it("shows no step as active once the run has stopped for a person", () => {
    const phases = preparationPhases("NEEDS_REVIEW", [step("identity"), step("sources"), step("enrichment")]);
    expect(phases.some((phase) => phase.state === "active")).toBe(false);
    expect(phases.filter((phase) => phase.state === "done")).toHaveLength(3);
  });

  it("is honest about a step that finished without doing all of its work", () => {
    const phases = preparationPhases("VERIFYING", [step("identity"), step("sources"), step("enrichment", "degraded")]);
    expect(phases.find((phase) => phase.key === "enrichment")?.state).toBe("partial");
    expect(phases.find((phase) => phase.key === "enrichment")?.detail).toBe("enrichment finished");
  });

  it("shows every step finished for a ready run", () => {
    const phases = preparationPhases("READY", PREPARATION_STEPS.map((key) => step(key)));
    expect(phases.every((phase) => phase.state === "done")).toBe(true);
  });

  it("uses staff wording for every step, never the internal key", () => {
    for (const phase of preparationPhases("IDENTIFYING", [])) {
      expect(phase.label).not.toBe(phase.key);
      expect(phase.label[0]).toBe(phase.label[0].toUpperCase());
    }
  });
});

describe("issues", () => {
  it("offers a source form rather than the provider's name when discovery is not set up", () => {
    const issue = describeIssue({
      code: PREPARATION_CODES.AUTOMATIC_SOURCE_DISCOVERY_NOT_CONFIGURED,
      message: "There is nothing to research this product from, and automatic source discovery is not set up.",
      remedy: "Give the manufacturer's page for this product.",
    });
    expect(issue.title).toBe("SeoPulse needs a product source");
    expect(issue.title).not.toContain("AUTOMATIC");
    expect(issue.actions).toContain("sources");
    expect(issue.actions).toContain("manual");
  });

  it("explains too little knowledge with the backend's own account of what is missing", () => {
    const issue = describeIssue({
      code: PREPARATION_CODES.INSUFFICIENT_KNOWLEDGE,
      message: "There is too little established about this product: 2 of the 6 facts needed.",
      remedy: "Add what is missing — weight, dimensions — or attach the manufacturer's specification.",
    });
    expect(issue.title).toBe("SeoPulse needs more product information");
    expect(issue.message).toContain("2 of the 6 facts needed");
    expect(issue.remedy).toContain("weight, dimensions");
    expect(issue.actions).toEqual(["sources", "specifications", "recheck"]);
  });

  it("sends a disagreement between sources to the screen that decides it", () => {
    const issue = describeIssue({
      code: PREPARATION_CODES.CLAIMS_CONFLICT,
      message: "2 values where the sources disagree.",
      remedy: "Decide which value is right.",
    });
    expect(issue.actions[0]).toBe("intelligence");
  });

  it("gives every backend code a heading that is not the code", () => {
    for (const code of Object.values(PREPARATION_CODES)) {
      const issue = describeIssue({ code, message: "m", remedy: "r" });
      expect(issue.title, code).not.toContain("_");
      expect(issue.title, code).not.toBe(code);
    }
  });

  it("still shows a code it has never seen, using the backend's words", () => {
    const issue = describeIssue({ code: "SOMETHING_NEW", message: "A new thing happened.", remedy: "Do this." });
    expect(issue.message).toBe("A new thing happened.");
    expect(issue.remedy).toBe("Do this.");
    expect(issue.actions.length).toBeGreaterThan(0);
  });

  it("counts what needs attention in words", () => {
    expect(attentionSummary(1)).toBe("1 thing needs your attention");
    expect(attentionSummary(2)).toBe("2 things need your attention");
  });
});

describe("what staff are told about discovery and identity", () => {
  it("never names the provider", () => {
    for (const configured of [true, false]) {
      const described = describeDiscovery(configured);
      expect(described.label.toLowerCase()).not.toContain("brave");
      expect(described.hint.toLowerCase()).not.toContain("api");
      expect(described.available).toBe(configured);
    }
  });

  it("turns the resolution states into something a person can act on", () => {
    expect(describeIdentityState("VERIFIED").label).toBe("Identified");
    expect(describeIdentityState("HIGH_CONFIDENCE").label).toBe("Identified");
    expect(describeIdentityState("AMBIGUOUS").label).toBe("Needs review");
    expect(describeIdentityState("UNRESOLVED").label).toBe("Needs information");
    expect(describeIdentityState(null).tone).toBe("plain");
    for (const state of ["VERIFIED", "HIGH_CONFIDENCE", "AMBIGUOUS", "UNRESOLVED", null] as const) {
      expect(describeIdentityState(state).label).not.toContain("_");
    }
  });
});
