import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';
import { BusinessRuleError } from '../shared/errors.js';
import type { Wallet } from '../wallet/wallet.js';
import { FailureCode } from './failure-code.js';
import { WagerTransactionKind, type WagerTransaction } from './wager-transaction.js';

export type ApplyOutcome =
  | { status: 'PROCESSED'; entry: WalletLedgerEntry | undefined }
  | { status: 'REJECTED'; failureCode: FailureCode };

export interface ApplyContext {
  /** Required for REFUND/ROLLBACK; the caller resolves it and marks PENDING_REFERENCE when missing. */
  reference?: WagerTransaction;
  /** True when `reference` was already reverted by a transaction of the same kind. */
  referenceAlreadyReversed?: boolean;
  ledgerEntryId: string;
  at: Date;
}

/**
 * Business rules of the wagering table (section 7 of the challenge), as a pure
 * function over already-locked state. Mutates `wallet` and `tx`; the caller
 * persists both plus the returned entry in one SQL transaction.
 */
export function applyWagerTransaction(wallet: Wallet, tx: WagerTransaction, ctx: ApplyContext): ApplyOutcome {
  try {
    if (tx.walletId !== wallet.id || tx.playerId !== wallet.playerId) {
      throw new BusinessRuleError(FailureCode.WalletPlayerMismatch, 'Wallet does not belong to player');
    }
    if (tx.money.currency !== wallet.currency) {
      throw new BusinessRuleError(FailureCode.CurrencyMismatch, 'Operation currency differs from wallet');
    }

    let reference: WagerTransaction | undefined;
    if (tx.isReversal()) {
      reference = ctx.reference;
      if (!reference) {
        throw new Error('Reversal applied without a resolved reference');
      }
      tx.assertCanReverse(reference);
      if (ctx.referenceAlreadyReversed) {
        throw new BusinessRuleError(FailureCode.ReferenceAlreadyReversed, 'Reference already reversed');
      }
    }

    let entry: WalletLedgerEntry | undefined;
    if (tx.affectsBalance()) {
      const movement = { entryId: ctx.ledgerEntryId, transactionId: tx.id, at: ctx.at };
      const direction = tx.ledgerDirectionFor(reference);
      if (direction === LedgerDirection.Credit) {
        entry = wallet.credit(tx.money, movement);
      } else {
        const code =
          tx.kind === WagerTransactionKind.Rollback
            ? FailureCode.ReversalInsufficientFunds
            : FailureCode.InsufficientFunds;
        entry = wallet.debit(tx.money, movement, code);
      }
    }

    tx.markProcessed(reference?.id, ctx.at, wallet.balance);
    return { status: 'PROCESSED', entry };
  } catch (error) {
    if (error instanceof BusinessRuleError) {
      tx.reject(error.failureCode, ctx.at, wallet.balance);
      return { status: 'REJECTED', failureCode: error.failureCode };
    }
    throw error;
  }
}
