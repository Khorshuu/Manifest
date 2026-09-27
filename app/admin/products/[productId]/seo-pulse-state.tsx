/**
 * Whether the SeoPulse wording in a section is current (D-123).
 *
 * A field SeoPulse filled while the product's research was incomplete held
 * the product's name dressed as copy — "… – Price in Bangladesh" — and looked
 * exactly like the output of finished research. The editor now says which it
 * is: wording from an earlier or incomplete run is labelled as previous
 * SeoPulse content, and an empty field says what it is waiting for. Staff
 * wording is never labelled; it is theirs.
 */

import type { SeoPulseContentState } from "@/lib/preparation/presentation";

export type { SeoPulseContentState };

export function SeoPulseStateNotice({
  state,
  scope,
}: {
  state: SeoPulseContentState | undefined;
  scope: "content" | "seo";
}) {
  if (!state) return null;
  if (state.stale.length > 0) {
    const list = state.stale.join(" and ");
    const verb = state.stale.length === 1 ? "was" : "were";
    return (
      <p
        role="status"
        data-seopulse-state="stale"
        className="max-w-2xl rounded-control border border-brass bg-brass/10 px-3 py-2 text-meta text-ink"
      >
        <strong>Previous SeoPulse content.</strong>{" "}
        {state.reason === "insufficient"
          ? `The ${list} below ${verb} written by SeoPulse, and the product's verified information does not stand behind ${state.stale.length === 1 ? "it" : "them"} now: too little is established.`
          : `The ${list} below ${verb} written by an earlier SeoPulse run. The latest preparation has not finished, so ${state.stale.length === 1 ? "it is" : "they are"} not its result.`}{" "}
        Keep, edit or clear {state.stale.length === 1 ? "it" : "them"}; SeoPulse replaces its own wording when it prepares the product from verified information.
      </p>
    );
  }
  if (state.pending) {
    return (
      <p
        role="status"
        data-seopulse-state="pending"
        className="max-w-2xl rounded-control border border-blue-300 bg-blue-50/60 px-3 py-2 text-meta text-ink"
      >
        {scope === "seo"
          ? "SEO will be prepared after enough product information is verified."
          : "Customer content will be prepared after enough product information is verified."}
      </p>
    );
  }
  return null;
}
