/**
 * Structured logging (lib/observability/log.ts): one JSON line per event,
 * secrets and personal details never written, durations and outcomes
 * recorded, and the work's own error rethrown.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent, redact, timed } from "@/lib/observability/log";

afterEach(() => {
  vi.restoreAllMocks();
});

function captured(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
}

describe("redact", () => {
  it("replaces sensitive fields whatever their nesting", () => {
    expect(
      redact({
        password: "hunter2",
        body: { sessionToken: "abc", nested: [{ webhookSignature: "sig", cardNumber: "4111" }] },
        headers: { authorization: "Bearer x", cookie: "session=1" },
        amountBdt: 5000,
      }),
    ).toEqual({
      password: "[redacted]",
      body: { sessionToken: "[redacted]", nested: [{ webhookSignature: "[redacted]", cardNumber: "[redacted]" }] },
      headers: { authorization: "[redacted]", cookie: "[redacted]" },
      amountBdt: 5000,
    });
  });

  it("masks email addresses and phone numbers inside text", () => {
    expect(redact("Order for nadia.rahman@example.com, phone +8801711223344")).toBe(
      "Order for n***@example.com, phone ***344",
    );
  });

  it("keeps an error's name and message, masked", () => {
    const logged = redact(new Error("No account for shopper@example.com")) as { name: string; message: string };
    expect(logged).toMatchObject({ name: "Error", message: "No account for s***@example.com" });
  });
});

describe("logEvent", () => {
  it("writes one JSON line with level, event and fields", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await logEvent("info", "checkout.placed", { orderNumber: "ORD-2026-000001", password: "x" });
    const [entry] = captured(spy);
    expect(entry).toMatchObject({ level: "info", event: "checkout.placed", orderNumber: "ORD-2026-000001", password: "[redacted]" });
    expect(Date.parse(entry.ts)).not.toBeNaN();
  });
});

describe("timed", () => {
  it("records the duration and outcome of work that succeeds", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await timed("search.run", { query: "candy" }, async () => 42, (value) => ({ results: value }));
    expect(result).toBe(42);
    expect(captured(spy)[0]).toMatchObject({ event: "search.run", outcome: "ok", results: 42 });
    expect(typeof captured(spy)[0].durationMs).toBe("number");
  });

  it("logs a failure as an error and rethrows the original", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("database unavailable");
    await expect(timed("checkout.place", {}, async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(captured(spy)[0]).toMatchObject({ level: "error", outcome: "failed", error: { message: "database unavailable" } });
  });

  it("logs an expected refusal as a warning, not an error", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refusal = Object.assign(new Error("That preorder is full."), { status: 409 });
    await expect(timed("checkout.place", {}, async () => Promise.reject(refusal))).rejects.toBe(refusal);
    expect(captured(spy)[0]).toMatchObject({ level: "warn", outcome: "failed" });
  });
});
