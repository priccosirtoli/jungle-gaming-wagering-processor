import { Inject, Injectable, Logger } from '@nestjs/common';
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../domain/money/money.js';
import { Wallet } from '../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry.js';
import { WagerTransaction } from '../domain/wager/wager-transaction.js';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/wagering-events.js';
import { OutboxMessage } from '../domain/outbox/outbox-message.js';
import { WagerTransactionRecord, WalletRecord } from '../infrastructure/database/entities.js';
import {
  ledgerEntryToRecord,
  ledgerRowToDomain,
  outboxToRecord,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
  type LedgerRow,
} from '../infrastructure/database/mappers.js';
import type { CreateWalletCommand } from './commands.js';
import { NotFoundError, ValidationError, WalletAlreadyExistsError } from './errors.js';
import { newId } from './ids.js';
import { Metrics } from '../infrastructure/observability/metrics.js';
import { payloadHash } from './payload-hash.js';

/** Provider id used for internal OPENING transactions. */
export const INTERNAL_PROVIDER = 'internal';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | undefined;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

const MAX_PAGE = 200;

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  /** Wallet, OPENING transaction, ledger entry and events in one SQL transaction. */
  async create(cmd: CreateWalletCommand, correlationId: string): Promise<Wallet> {
    const now = new Date();
    const walletId = newId();
    const opening = cmd.initialBalance.isPositive()
      ? WagerTransaction.createOpening({
          id: newId(),
          providerId: INTERNAL_PROVIDER,
          externalTransactionId: `opening:${walletId}`,
          idempotencyKey: `${INTERNAL_PROVIDER}:opening:${walletId}`,
          payloadHash: payloadHash({ playerId: cmd.playerId, initialBalance: cmd.initialBalance.toJSON() }),
          walletId,
          playerId: cmd.playerId,
          roundId: 'opening',
          gameId: 'internal',
          money: cmd.initialBalance,
          createdAt: now,
        })
      : undefined;
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: cmd.playerId,
      initialBalance: cmd.initialBalance,
      opening: opening ? { transactionId: opening.id, entryId: newId() } : undefined,
      at: now,
    });

    try {
      await this.orm.em.fork().transactional(async (em) => {
        em.persist(walletToRecord(wallet));
        await em.flush();
        if (opening && openingEntry) {
          opening.markProcessed(undefined, now, wallet.balance);
          em.persist(transactionToRecord(opening, now));
          await em.flush();
          em.persist(ledgerEntryToRecord(openingEntry));
          const ctx = { newId, correlationId, occurredAt: now };
          em.persist(outboxToRecord(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, wallet, ctx))));
          em.persist(outboxToRecord(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx))));
        }
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(`Player already has a ${wallet.currency} wallet`);
      }
      throw error;
    }
    return wallet;
  }

  async get(walletId: string): Promise<Wallet> {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id: walletId });
    if (!record) {
      throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
    }
    return walletToDomain(record);
  }

  /** Keyset pagination on the ledger sequence; the cursor is opaque to clients. */
  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    await this.get(walletId);
    const size = Math.min(Math.max(Math.trunc(limit) || 50, 1), MAX_PAGE);
    const after = cursor === undefined ? '0' : decodeCursor(cursor);
    const rows = await this.orm.em.fork().execute<LedgerRow[]>(
      `select id, seq::text as seq, wallet_id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after, created_at
         from wallet_ledger_entries
        where wallet_id = ? and seq > ?
        order by seq
        limit ?`,
      [walletId, after, size + 1],
    );
    const page = rows.slice(0, size);
    const last = page.at(-1);
    return {
      entries: page.map(ledgerRowToDomain),
      nextCursor: rows.length > size && last ? encodeCursor(last.seq) : undefined,
    };
  }

  /**
   * Compares the stored balance with the balance rebuilt from the ledger, under
   * a shared lock so no movement lands in between. Divergences are reported and
   * logged, never corrected silently.
   */
  async reconcile(walletId: string): Promise<ReconciliationResult> {
    return this.orm.em.fork().transactional(async (em) => {
      const record = await em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_READ });
      if (!record) {
        throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
      }
      const wallet = walletToDomain(record);
      const [row] = await em.execute<{ total: string; entries: string }[]>(
        `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::text as total,
                count(*)::text as entries
           from wallet_ledger_entries where wallet_id = ?`,
        [walletId],
      );
      const calculated = signedMoney(row?.total ?? '0', wallet.currency);
      const difference = wallet.balance.subtract(calculated);
      const result: ReconciliationResult = {
        walletId,
        storedBalance: wallet.balance,
        calculatedBalance: calculated,
        difference,
        consistent: difference.isZero(),
        checkedEntries: Number(row?.entries ?? 0),
      };
      if (!result.consistent) {
        this.metrics.increment('reconciliation_divergences_total');
        this.logger.warn({
          message: 'Wallet balance diverges from ledger',
          walletId,
          difference: difference.toString(),
          checkedEntries: result.checkedEntries,
        });
      }
      return result;
    });
  }

  async transactionById(id: string): Promise<WagerTransaction> {
    return this.findTransaction({ id });
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    return this.findTransaction({ providerId, externalTransactionId });
  }

  /** Balance to show next to a transaction: observed at its outcome, else current. */
  async balanceFor(tx: WagerTransaction): Promise<Money> {
    return tx.observedBalance ?? (await this.get(tx.walletId)).balance;
  }

  private async findTransaction(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction> {
    const record = await this.orm.em.fork().findOne(WagerTransactionRecord, where);
    if (!record) {
      throw new NotFoundError('TRANSACTION_NOT_FOUND', 'Transaction not found');
    }
    return transactionToDomain(record);
  }
}

function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.zero(currency).subtract(Money.from({ amount: amount.slice(1), currency }))
    : Money.from({ amount, currency });
}

function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ seq }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const { seq } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { seq?: unknown };
    if (typeof seq === 'string' && /^\d+$/.test(seq)) {
      return seq;
    }
  } catch {
    // fall through
  }
  throw new ValidationError('Invalid cursor');
}
