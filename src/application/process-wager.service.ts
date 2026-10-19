import { Inject, Injectable, Logger } from '@nestjs/common';
import { LockMode, LockWaitTimeoutException, UniqueConstraintViolationException } from '@mikro-orm/core';
import { Metrics } from '../infrastructure/observability/metrics.js';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import type { Money } from '../domain/money/money.js';
import { applyWagerTransaction } from '../domain/wager/apply-wager-transaction.js';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager/wager-transaction.js';
import type { EventContext, IntegrationEvent } from '../domain/events/integration-event.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wagering-events.js';
import { OutboxMessage } from '../domain/outbox/outbox-message.js';
import type { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry.js';
import { WagerTransactionRecord, WalletRecord } from '../infrastructure/database/entities.js';
import {
  ledgerEntryToRecord,
  outboxToRecord,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from '../infrastructure/database/mappers.js';
import { hashWagerCommand, type SubmitWagerCommand } from './commands.js';
import { IdempotencyConflictError, NotFoundError } from './errors.js';
import { newId } from './ids.js';

export interface WagerResult {
  transaction: WagerTransaction;
  balance: Money;
  idempotentReplay: boolean;
}

export interface ProcessMeta {
  correlationId: string;
  causationId?: string | undefined;
  /** Set when the command came from SQS: recorded in the inbox in the same SQL transaction. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string } | undefined;
}

/** Bounded wait for the wallet row lock; on timeout the caller gets a retryable error. */
const LOCK_TIMEOUT = '5s';

/**
 * The single wagering use case, shared by HTTP and SQS.
 *
 * Concurrency: the wallet row is locked with SELECT ... FOR UPDATE for the whole
 * SQL transaction, so operations on one wallet are serialized across every
 * instance while different wallets proceed in parallel. The balance is then
 * read, computed and written under that lock, and the schema rejects anything
 * that slips through (balance >= 0, unique keys, one ledger entry per transaction).
 *
 * Atomicity: transaction row, ledger entry, wallet update, inbox row and outbox
 * events are flushed in one SQL transaction; nothing is published before commit.
 */
@Injectable()
export class ProcessWagerService {
  private readonly logger = new Logger(ProcessWagerService.name);

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  async execute(cmd: SubmitWagerCommand, meta: ProcessMeta): Promise<WagerResult> {
    const started = performance.now();
    const source = meta.inbox ? 'sqs' : 'http';
    const result = await this.executeOnce(cmd, meta).catch((error: unknown) => {
      if (error instanceof LockWaitTimeoutException) {
        this.metrics.increment('wallet_lock_timeouts_total');
      }
      throw error;
    });
    this.metrics.increment('wager_transactions_total', 1, { status: result.transaction.status, source });
    if (result.idempotentReplay) {
      this.metrics.increment('duplicates_detected_total', 1, { source });
    }
    this.metrics.observeMs('wager_processing_ms', performance.now() - started, { source });
    return result;
  }

  private async executeOnce(cmd: SubmitWagerCommand, meta: ProcessMeta): Promise<WagerResult> {
    const hash = hashWagerCommand(cmd);
    try {
      return await this.orm.em.fork().transactional((em) => this.process(em, cmd, hash, meta));
    } catch (error) {
      // A concurrent request with the same key (or provider + external id) won the
      // race on another wallet lock; the unique index decided. Answer from its row.
      if (error instanceof UniqueConstraintViolationException) {
        const replay = await this.replayExisting(this.orm.em.fork(), cmd, hash);
        if (replay) {
          return replay;
        }
      }
      throw error;
    }
  }

  private async process(em: EntityManager, cmd: SubmitWagerCommand, hash: string, meta: ProcessMeta): Promise<WagerResult> {
    await em.execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`);

    const lockStarted = performance.now();
    const walletRecord = await em.findOne(WalletRecord, { id: cmd.walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    // Time spent waiting for other operations on the same wallet (lock contention).
    this.metrics.observeMs('wallet_lock_wait_ms', performance.now() - lockStarted);
    if (!walletRecord) {
      throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${cmd.walletId} not found`);
    }

    if (meta.inbox) {
      const fresh = await this.recordInbox(em, meta.inbox);
      if (!fresh) {
        this.metrics.increment('inbox_duplicates_total');
        this.logger.log({ message: 'Duplicate message detected by inbox', messageId: meta.inbox.messageId });
      }
    }

    const replay = await this.replayExisting(em, cmd, hash, walletRecord);
    if (replay) {
      return replay;
    }

    const now = new Date();
    const wallet = walletToDomain(walletRecord);
    const tx = WagerTransaction.create({
      id: newId(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: hash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: cmd.money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });
    const events: EventContext = { newId, correlationId: meta.correlationId, causationId: meta.causationId, occurredAt: now };

    let reference: WagerTransaction | undefined;
    let referenceAlreadyReversed = false;
    if (tx.isReversal()) {
      const referenceRecord = await em.findOne(WagerTransactionRecord, {
        providerId: tx.providerId,
        externalTransactionId: tx.referenceExternalTransactionId!,
      });
      if (!referenceRecord) {
        tx.markPendingReference();
        await this.save(em, tx, now, [WagerTransactionPendingReference.from(tx, events)]);
        return { transaction: tx, balance: wallet.balance, idempotentReplay: false };
      }
      reference = transactionToDomain(referenceRecord);
      referenceAlreadyReversed =
        (await em.count(WagerTransactionRecord, {
          referenceTransactionId: reference.id,
          kind: tx.kind,
          status: WagerTransactionStatus.Processed,
        })) > 0;
    }

    const outcome = applyWagerTransaction(wallet, tx, { reference, referenceAlreadyReversed, ledgerEntryId: newId(), at: now });

    if (outcome.status === 'REJECTED') {
      await this.save(em, tx, now, [WagerTransactionRejected.from(tx, outcome.failureCode, events)]);
    } else {
      const published: IntegrationEvent<unknown>[] = [WagerTransactionProcessed.from(tx, wallet, events)];
      if (outcome.entry) {
        // walletRecord is managed by the unit of work: the next flush issues the UPDATE.
        walletToRecord(wallet, walletRecord);
        published.push(WalletBalanceChanged.from(wallet, outcome.entry, events));
      }
      await this.save(em, tx, now, published, outcome.entry);
    }
    return { transaction: tx, balance: wallet.balance, idempotentReplay: false };
  }

  /**
   * Two flushes inside the same SQL transaction: the transaction row (and the
   * wallet UPDATE) first, because the ledger entry references it via FK; then
   * the ledger entry and the outbox events. The records have no ORM relations
   * between them, so the order is made explicit here.
   */
  private async save(
    em: EntityManager,
    tx: WagerTransaction,
    now: Date,
    events: IntegrationEvent<unknown>[],
    ledgerEntry?: WalletLedgerEntry,
  ) {
    em.persist(transactionToRecord(tx, now));
    await em.flush();
    if (ledgerEntry) {
      em.persist(ledgerEntryToRecord(ledgerEntry));
    }
    for (const event of events) {
      em.persist(outboxToRecord(OutboxMessage.enqueue(event)));
    }
    await em.flush();
  }

  /** Inserts the inbox row; returns false when this message was already recorded. */
  private async recordInbox(em: EntityManager, inbox: NonNullable<ProcessMeta['inbox']>): Promise<boolean> {
    const rows = await em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, now(), now())
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [inbox.consumerName, inbox.messageId, inbox.payloadHash],
    );
    return rows.length > 0;
  }

  /**
   * Idempotency: an existing transaction with the same key and payload is a
   * replay (original outcome and observed balance); anything else colliding on
   * the key or on (provider, external id) is a conflict.
   */
  private async replayExisting(
    em: EntityManager,
    cmd: SubmitWagerCommand,
    hash: string,
    walletRecord?: WalletRecord,
  ): Promise<WagerResult | undefined> {
    const existing = await em.findOne(WagerTransactionRecord, {
      $or: [
        { idempotencyKey: cmd.idempotencyKey },
        { providerId: cmd.providerId, externalTransactionId: cmd.externalTransactionId },
      ],
    });
    if (!existing) {
      return undefined;
    }
    if (existing.idempotencyKey !== cmd.idempotencyKey || existing.payloadHash !== hash) {
      throw new IdempotencyConflictError(
        'A transaction with this idempotency key or external id already exists with a different payload',
      );
    }
    const transaction = transactionToDomain(existing);
    let balance = transaction.observedBalance;
    if (!balance) {
      const current = walletRecord ?? (await em.findOneOrFail(WalletRecord, { id: existing.walletId }));
      balance = walletToDomain(current).balance;
    }
    return { transaction, balance, idempotentReplay: true };
  }
}
