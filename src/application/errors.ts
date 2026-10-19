/** Errors raised by use cases that are not domain rules (lookups, idempotency). */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends ApplicationError {
  constructor(
    readonly code: 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

/** Same idempotency key (or provider + external id) with a different payload. Never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

/** The request itself is malformed (shape, types, formats). */
export class ValidationError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';
}
