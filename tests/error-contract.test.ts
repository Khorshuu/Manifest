/**
 * What a client sees when something goes wrong.
 *
 * Known database conflicts get an honest status and a plain message — never
 * the driver's text, which can carry table names and customer data — and a
 * transient conflict says when to retry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { toErrorResponse } from "@/lib/api-error";
import { ConflictError, NotFoundError, TransientConflictError, ValidationError } from "@/lib/errors";
import {
  databaseConstraint,
  databaseErrorCode,
  isTransientDatabaseError,
  isUniqueViolation,
  withTransientRetry,
} from "@/lib/db-errors";

/** Shaped like Drizzle's wrapper around a postgres-js error. */
function wrapped(code: string, extra: Record<string, unknown> = {}) {
  const driver = Object.assign(new Error("duplicate key value violates unique constraint"), { code, ...extra });
  return Object.assign(new Error("Failed query: insert into orders …"), { cause: driver });
}

afterEach(() => vi.restoreAllMocks());

describe("toErrorResponse", () => {
  it("passes a domain error's status, message and code through", async () => {
    const response = toErrorResponse(new ConflictError("That preorder is full.", "sold_out"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "That preorder is full.", code: "sold_out" });
  });

  it.each([
    [new ValidationError("Check the email address."), 400],
    [new NotFoundError(), 404],
  ])("maps %s to %i", (error, status) => {
    expect(toErrorResponse(error).status).toBe(status);
  });

  it("tells the client to retry a transient conflict", async () => {
    const response = toErrorResponse(new TransientConflictError());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({ code: "retry" });
  });

  it("answers a raw deadlock as a retryable 503, not a 500", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = toErrorResponse(wrapped("40P01"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
  });

  it("answers a unique violation as 409 without the driver's text", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = toErrorResponse(
      wrapped("23505", { detail: "Key (email)=(someone@example.com) already exists.", constraint_name: "users_email_unique" }),
    );
    expect(response.status).toBe(409);
    const body = JSON.stringify(await response.json());
    expect(body).not.toMatch(/someone@example\.com|users_email_unique|insert into/);
  });

  it("still reports an unknown failure as a generic 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = toErrorResponse(new Error("boom"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Something went wrong. Try again." });
  });
});

describe("database error recognition", () => {
  it("finds the SQLSTATE and constraint however deeply wrapped", () => {
    const error = { cause: { cause: { code: "23505", constraint: "orders_idempotency_key_unique" } } };
    expect(databaseErrorCode(error)).toBe("23505");
    expect(databaseConstraint(error)).toBe("orders_idempotency_key_unique");
    expect(isUniqueViolation(error, "orders_idempotency_key_unique")).toBe(true);
    expect(isUniqueViolation(error, "users_email_unique")).toBe(false);
  });

  it("treats only deadlock and serialisation failure as transient", () => {
    expect(isTransientDatabaseError(wrapped("40P01"))).toBe(true);
    expect(isTransientDatabaseError(wrapped("40001"))).toBe(true);
    expect(isTransientDatabaseError(wrapped("23505"))).toBe(false);
    expect(isTransientDatabaseError(new Error("ECONNRESET"))).toBe(false);
  });
});

describe("withTransientRetry", () => {
  it("retries a transient failure and returns the eventual result", async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw wrapped("40P01");
        return "placed";
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe("placed");
    expect(calls).toBe(3);
  });

  it("gives up after the attempt limit", async () => {
    let calls = 0;
    await expect(
      withTransientRetry(
        async () => {
          calls += 1;
          throw wrapped("40001");
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ cause: { code: "40001" } });
    expect(calls).toBe(3);
  });

  it("never retries a non-transient failure", async () => {
    let calls = 0;
    await expect(
      withTransientRetry(async () => {
        calls += 1;
        throw wrapped("23514");
      }),
    ).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });
});
