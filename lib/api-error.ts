import { NextResponse } from "next/server";
import {
  databaseErrorCode,
  PG_CHECK_VIOLATION,
  PG_DEADLOCK_DETECTED,
  PG_FOREIGN_KEY_VIOLATION,
  PG_INVALID_TEXT_REPRESENTATION,
  PG_SERIALIZATION_FAILURE,
  PG_UNIQUE_VIOLATION,
} from "@/lib/db-errors";

/**
 * Turns a thrown error into a response.
 *
 * Errors that carry a `status` are ours and their message is safe to show.
 * A database failure with a recognised SQLSTATE is a known conflict, so it
 * gets an honest status and a plain message — never the driver's text, which
 * can name tables, columns and values. Anything else is logged and reported
 * as a generic failure.
 */

type KnownDatabaseFailure = {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
};

const DATABASE_FAILURES: Record<string, KnownDatabaseFailure> = {
  [PG_DEADLOCK_DETECTED]: {
    status: 503,
    code: "retry",
    message: "Several people are doing that at once. Please try again in a moment.",
    retryAfterSeconds: 1,
  },
  [PG_SERIALIZATION_FAILURE]: {
    status: 503,
    code: "retry",
    message: "Several people are doing that at once. Please try again in a moment.",
    retryAfterSeconds: 1,
  },
  [PG_UNIQUE_VIOLATION]: {
    status: 409,
    code: "conflict",
    message: "That already exists.",
  },
  [PG_FOREIGN_KEY_VIOLATION]: {
    status: 409,
    code: "conflict",
    message: "Something that depends on this has changed. Refresh and try again.",
  },
  [PG_CHECK_VIOLATION]: {
    status: 409,
    code: "conflict",
    message: "That change conflicts with the current data. Refresh and try again.",
  },
  [PG_INVALID_TEXT_REPRESENTATION]: {
    status: 400,
    code: "invalid",
    message: "Check the details you sent.",
  },
};

function withRetryAfter(response: NextResponse, seconds: number | undefined) {
  if (seconds !== undefined) response.headers.set("retry-after", String(seconds));
  return response;
}

export function toErrorResponse(error: unknown): NextResponse {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const known = error as {
      status: number;
      message: string;
      code?: unknown;
      retryAfterSeconds?: unknown;
    };
    return withRetryAfter(
      NextResponse.json(
        {
          error: known.message,
          ...(typeof known.code === "string" ? { code: known.code } : {}),
        },
        { status: known.status },
      ),
      typeof known.retryAfterSeconds === "number" ? known.retryAfterSeconds : undefined,
    );
  }

  const code = databaseErrorCode(error);
  const failure = code ? DATABASE_FAILURES[code] : undefined;

  if (failure) {
    // Logged by code only: the driver message can carry customer data.
    console.warn(`Known database conflict ${code} answered as ${failure.status}.`);
    return withRetryAfter(
      NextResponse.json(
        { error: failure.message, code: failure.code },
        { status: failure.status },
      ),
      failure.retryAfterSeconds,
    );
  }

  console.error(error);
  return NextResponse.json(
    { error: "Something went wrong. Try again." },
    { status: 500 },
  );
}
