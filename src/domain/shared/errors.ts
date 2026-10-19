import type { FailureCode } from '../wager/failure-code.js';

/** Base class for every error the domain raises on purpose. */
export abstract class DomainError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input that can never become a valid value object (bad amount, bad currency...). */
export class InvalidInputError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * A business rule rejected the operation. Carries the stable failure code the
 * transaction is rejected with.
 */
export class BusinessRuleError extends DomainError {
  constructor(
    public readonly failureCode: FailureCode,
    message: string,
  ) {
    super(message);
  }
}

/** Programming error: a terminal transaction was asked to transition again. */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}
