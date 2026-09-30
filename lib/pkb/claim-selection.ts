/**
 * Choosing many proposed values at once in Product Intelligence (D-128).
 *
 * Pure, so the rules the review screen follows are tested directly:
 *
 *  - "Select all" selects the claims that are shown and can be decided — the
 *    current filter's open claims — and nothing hidden by the filter.
 *  - An action acts on what is both selected and shown, so a claim selected
 *    under another filter is never decided by accident.
 *  - Selecting never decides anything: the person still presses Accept or
 *    Reject, and each goes through the one acceptance or rejection path, with
 *    its permission check, verification policy, audit record and history.
 *  - A large selection is sent in groups the server accepts (100), each all or
 *    nothing, one after another; the first group that is refused stops the
 *    rest, and the screen says exactly how many were decided and why the rest
 *    were not.
 */

export type ClaimFilter = "all" | "proposed" | "conflict";

export type SelectableClaim = { id: string; status: string };

/** Claims a person can still decide. */
export function isActionable(claim: SelectableClaim): boolean {
  return claim.status === "SUGGESTED" || claim.status === "CONFLICT";
}

export function visibleClaims<T extends SelectableClaim>(claims: T[], filter: ClaimFilter): T[] {
  return claims.filter(
    (claim) =>
      isActionable(claim) &&
      (filter === "all" || (filter === "proposed" ? claim.status === "SUGGESTED" : claim.status === "CONFLICT")),
  );
}

/** Adds every shown, decidable claim to the selection. */
export function selectAllVisible(selected: ReadonlySet<string>, visible: SelectableClaim[]): Set<string> {
  const next = new Set(selected);
  for (const claim of visible) if (isActionable(claim)) next.add(claim.id);
  return next;
}

/** What an action applies to: selected and shown, in the order shown. */
export function actionTargets(selected: ReadonlySet<string>, visible: SelectableClaim[]): string[] {
  return visible.filter((claim) => selected.has(claim.id)).map((claim) => claim.id);
}

/** Whether every shown decidable claim is selected (the header checkbox). */
export function allVisibleSelected(selected: ReadonlySet<string>, visible: SelectableClaim[]): boolean {
  return visible.length > 0 && visible.every((claim) => selected.has(claim.id));
}

/** The server takes at most this many claims in one decision. */
export const DECISION_BATCH = 100;

export function batches<T>(items: T[], size = DECISION_BATCH): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * Sends the batches one after another and stops at the first refusal. The
 * result says how many were decided and, when one was refused, its message.
 */
export async function decideInBatches(
  ids: string[],
  send: (batch: string[]) => Promise<{ ok: true } | { ok: false; error: string }>,
): Promise<{ decided: number; failed: number; error: string | null }> {
  let decided = 0;
  for (const batch of batches(ids)) {
    const result = await send(batch);
    if (!result.ok) return { decided, failed: ids.length - decided, error: result.error };
    decided += batch.length;
  }
  return { decided, failed: 0, error: null };
}

/** What the screen says after a bulk decision. */
export function decisionMessage(action: "accept" | "verify" | "reject", outcome: { decided: number; failed: number; error: string | null }): string {
  const verb = action === "reject" ? "Rejected" : action === "verify" ? "Accepted as verified" : "Accepted";
  const done = `${verb} ${outcome.decided} value${outcome.decided === 1 ? "" : "s"}.`;
  if (!outcome.error) return done;
  return `${outcome.decided > 0 ? `${done} ` : ""}${outcome.failed} not decided — nothing in that group was changed: ${outcome.error}`;
}
