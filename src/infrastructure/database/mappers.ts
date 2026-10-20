import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import type { FailureCode } from '../../domain/wager/failure-code.js';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager/wager-transaction.js';
import type { OutboxMessage } from '../../domain/outbox/outbox-message.js';
import { LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from './entities.js';

const money = (amount: string, currency: string) => Money.from({ amount, currency });

export function walletToDomain(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: money(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

/** Copies the aggregate state onto a (managed) record; the unit of work issues the UPDATE. */
export function walletToRecord(w: Wallet, target: WalletRecord = new WalletRecord()): WalletRecord {
  target.id = w.id;
  target.playerId = w.playerId;
  target.currency = w.currency;
  target.balance = w.balance.toString();
  target.version = w.version;
  target.createdAt = w.createdAt;
  target.updatedAt = w.updatedAt;
  return target;
}

export function transactionToDomain(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, r.currency),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: r.processedAt ?? undefined,
    observedBalance: r.observedBalance ? money(r.observedBalance, r.currency) : undefined,
  });
}

export function transactionToRecord(
  t: WagerTransaction,
  now: Date,
  target: WagerTransactionRecord = new WagerTransactionRecord(),
): WagerTransactionRecord {
  target.id = t.id;
  target.providerId = t.providerId;
  target.externalTransactionId = t.externalTransactionId;
  target.idempotencyKey = t.idempotencyKey;
  target.payloadHash = t.payloadHash;
  target.walletId = t.walletId;
  target.playerId = t.playerId;
  target.roundId = t.roundId;
  target.gameId = t.gameId;
  target.kind = t.kind;
  target.amount = t.money.toString();
  target.currency = t.money.currency;
  target.referenceExternalTransactionId = t.referenceExternalTransactionId ?? null;
  target.referenceTransactionId = t.referenceTransactionId ?? null;
  target.status = t.status;
  target.failureCode = t.failureCode ?? null;
  target.observedBalance = t.observedBalance?.toString() ?? null;
  target.createdAt = t.createdAt;
  target.processedAt = t.processedAt ?? null;
  target.updatedAt = now;
  target.referenceAttempts ??= 0;
  target.nextReferenceAttemptAt ??= null;
  return target;
}

export function ledgerEntryToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  const r = new LedgerEntryRecord();
  r.id = e.id;
  r.walletId = e.walletId;
  r.transactionId = e.transactionId;
  r.direction = e.direction;
  r.amount = e.money.toString();
  r.currency = e.money.currency;
  r.balanceBefore = e.balanceBefore.toString();
  r.balanceAfter = e.balanceAfter.toString();
  r.createdAt = e.createdAt;
  return r;
}

export interface LedgerRow {
  id: string;
  seq: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

export function ledgerRowToDomain(r: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.wallet_id,
    transactionId: r.transaction_id,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, r.currency),
    balanceBefore: money(r.balance_before, r.currency),
    balanceAfter: money(r.balance_after, r.currency),
    createdAt: new Date(r.created_at),
  });
}

export function outboxToRecord(m: OutboxMessage): OutboxRecord {
  const r = new OutboxRecord();
  r.id = m.id;
  r.aggregateId = m.aggregateId;
  r.eventType = m.eventType;
  r.payload = { ...m.payload };
  r.occurredAt = m.occurredAt;
  r.attempts = m.attempts;
  r.nextAttemptAt = m.nextAttemptAt ?? m.occurredAt;
  r.publishedAt = m.publishedAt ?? null;
  return r;
}
