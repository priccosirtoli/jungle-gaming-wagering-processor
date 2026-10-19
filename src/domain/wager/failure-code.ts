/**
 * Stable, machine-readable reasons a transaction ends REJECTED or FAILED.
 * Providers use these to decide whether to resend, fix the payload or give up.
 */
export const FailureCode = {
  /** BET larger than the available balance. Do not resend as-is. */
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  /** Reversing a credit (e.g. ROLLBACK of a WIN) would make the balance negative. */
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  /** The wallet does not belong to the player in the payload. */
  WalletPlayerMismatch: 'WALLET_PLAYER_MISMATCH',
  /** Referenced transaction never arrived within the retry window. */
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  /** Reference belongs to another provider, player, wallet, currency or round. */
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  /** REFUND must reference a BET; ROLLBACK a BET, WIN or REFUND. */
  ReferenceKindNotAllowed: 'REFERENCE_KIND_NOT_ALLOWED',
  /** Reference exists but was not PROCESSED, so there is nothing to revert. */
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  /** Reference was already reverted by an operation of the same kind. */
  ReferenceAlreadyReversed: 'REFERENCE_ALREADY_REVERSED',
  /** REFUND/ROLLBACK amount differs from the referenced amount (no partial reversal). */
  AmountMismatch: 'AMOUNT_MISMATCH',
  /** Permanent infrastructure failure; transaction marked FAILED for audit. */
  InfrastructureFailure: 'INFRASTRUCTURE_FAILURE',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
