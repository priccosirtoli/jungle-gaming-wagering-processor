import type { Money, MoneyProps } from '../domain/money/money.js';
import type { Wallet } from '../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry.js';
import { WagerTransactionStatus, type WagerTransaction } from '../domain/wager/wager-transaction.js';
import type { ReconciliationResult } from '../application/wallet.service.js';
import type { WagerResult } from '../application/process-wager.service.js';

export function walletView(w: Wallet) {
  return { id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version };
}

export function ledgerEntryView(e: WalletLedgerEntry) {
  return {
    id: e.id,
    transactionId: e.transactionId,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    createdAt: e.createdAt.toISOString(),
  };
}

export function transactionView(t: WagerTransaction, balance: Money) {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    status: t.status,
    ...(t.referenceExternalTransactionId ? { referenceExternalTransactionId: t.referenceExternalTransactionId } : {}),
    ...(t.referenceTransactionId ? { referenceTransactionId: t.referenceTransactionId } : {}),
    ...(t.failureCode ? { failureCode: t.failureCode } : {}),
    balance: balance.toJSON(),
    createdAt: t.createdAt.toISOString(),
    ...(t.processedAt ? { processedAt: t.processedAt.toISOString() } : {}),
  };
}

export interface WagerResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}

export function wagerResponse(r: WagerResult): WagerResponse {
  return {
    transactionId: r.transaction.id,
    status: r.transaction.status,
    balance: r.balance.toJSON(),
    idempotentReplay: r.idempotentReplay,
    ...(r.transaction.failureCode ? { failureCode: r.transaction.failureCode } : {}),
  };
}

/** PROCESSED 200, PENDING_REFERENCE 202 (accepted, applied later), REJECTED 422. Replays keep the original code. */
export function wagerHttpStatus(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export function reconciliationView(r: ReconciliationResult) {
  return {
    walletId: r.walletId,
    storedBalance: r.storedBalance.toJSON(),
    calculatedBalance: r.calculatedBalance.toJSON(),
    difference: r.difference.toJSON(),
    consistent: r.consistent,
    checkedEntries: r.checkedEntries,
  };
}
