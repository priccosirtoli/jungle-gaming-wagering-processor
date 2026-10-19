import type { Money } from '../money/money.js';
import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';
import { BusinessRuleError, InvalidInputError, InvalidTransactionStateError } from '../shared/errors.js';
import { FailureCode } from './failure-code.js';

export enum WagerTransactionKind {
  /** Internal: wallet opening credit. Never accepted from the API or the queue. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Kinds each reversal may point at. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>> = {
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  observedBalance?: Money | undefined;
}

/**
 * Valid transitions:
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PROCESSED, REJECTED, FAILED are terminal.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider, not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    /** Wallet balance when the transaction reached its outcome; returned on replays. */
    private _observedBalance?: Money,
  ) {}

  /** Provider-submitted transaction. Starts PENDING; OPENING is not accepted here. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidInputError('OPENING is internal and cannot be submitted');
    }
    return WagerTransaction.build(props);
  }

  /** Internal opening credit, created together with the wallet. */
  static createOpening(
    props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>,
  ): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const tx = WagerTransaction.rehydrate({ ...props, status: WagerTransactionStatus.Pending });
    if (tx.requiresReference() && !props.referenceExternalTransactionId) {
      throw new InvalidInputError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (tx.affectsBalance() && !props.money.isPositive()) {
      throw new InvalidInputError(`${props.kind} amount must be greater than zero`);
    }
    return tx;
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
  }

  markPendingReference(): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._observedBalance = observedBalance;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** LOSS records the round result without moving money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK inverts the direction of what it reverts; every other kind is fixed. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new Error('ROLLBACK direction depends on its reference');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new Error('LOSS has no ledger direction');
    }
  }

  /**
   * Checks that a reversal may revert `reference`. Throws BusinessRuleError with
   * the failure code to reject with. "Already reversed" needs the database and
   * is checked by the use case (and by a unique index).
   */
  assertCanReverse(reference: WagerTransaction): void {
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      throw new BusinessRuleError(FailureCode.ReferenceMismatch, 'Reference belongs to another context');
    }
    if (!ALLOWED_REFERENCE_KINDS[this.kind]?.has(reference.kind)) {
      throw new BusinessRuleError(
        FailureCode.ReferenceKindNotAllowed,
        `${this.kind} cannot reference ${reference.kind}`,
      );
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new BusinessRuleError(FailureCode.ReferenceNotProcessed, 'Reference is not PROCESSED');
    }
    if (!reference.money.equals(this.money)) {
      throw new BusinessRuleError(FailureCode.AmountMismatch, 'Reversal amount must equal the reference');
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot ${transition}: transaction is ${this._status}`);
    }
  }
}
