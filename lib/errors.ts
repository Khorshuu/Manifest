/**
 * Typed application errors.
 *
 * The domain already throws errors that carry an HTTP `status` (CheckoutError,
 * TransitionError, CapacityUnavailableError…), and `toErrorResponse` shows
 * their message as-is. These base classes give new code the same contract with
 * a stable machine-readable `code`, so a client can tell "sold out" from
 * "try again" without parsing prose.
 */

export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = "invalid") {
    super(message, 400, code);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "That could not be found.", code = "not_found") {
    super(message, 404, code);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "conflict") {
    super(message, 409, code);
  }
}

/**
 * A conflict that is expected to clear on its own — two checkouts contending
 * for the same rows. Safe for the client to retry after `retryAfterSeconds`.
 */
export class TransientConflictError extends AppError {
  constructor(
    message = "Several people are checking out at once. Please try again in a moment.",
    readonly retryAfterSeconds = 1,
  ) {
    super(message, 503, "retry");
  }
}
