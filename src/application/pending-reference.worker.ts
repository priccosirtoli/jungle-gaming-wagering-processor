import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionStatus } from '../domain/wager/wager-transaction.js';
import { WagerTransactionRecord, WalletRecord } from '../infrastructure/database/entities.js';
import { transactionToDomain, walletToDomain } from '../infrastructure/database/mappers.js';
import { Metrics } from '../infrastructure/observability/metrics.js';
import { APP_CONFIG } from '../tokens.js';
import type { AppConfig } from '../config.js';
import { newId } from './ids.js';
import { ProcessWagerService } from './process-wager.service.js';

/**
 * Retries reversals that arrived before their reference. Runs on every
 * instance; each retry takes the wallet lock and re-checks the row, so two
 * workers picking the same transaction cannot both apply it.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = false;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(ProcessWagerService) private readonly processWager: ProcessWagerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.pendingReference.enabled) {
      this.schedule(this.config.pendingReference.intervalMs);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.retryDue()
        .catch((error) => this.logger.error({ message: 'Pending reference cycle failed', error: String(error) }))
        .finally(() => this.schedule(this.config.pendingReference.intervalMs));
    }, delayMs);
  }

  /** Retries every due PENDING_REFERENCE transaction once. Returns how many reached a terminal state. */
  async retryDue(now = new Date()): Promise<number> {
    const due = await this.orm.em.fork().execute<{ id: string; wallet_id: string }[]>(
      `select id, wallet_id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= ?
        order by next_reference_attempt_at
        limit ?`,
      [now, this.config.pendingReference.batchSize],
    );
    let settled = 0;
    for (const row of due) {
      try {
        if (await this.retryOne(row.id, row.wallet_id, now)) settled += 1;
      } catch (error) {
        this.logger.warn({ message: 'Pending reference retry failed', transactionId: row.id, error: String(error) });
      }
    }
    return settled;
  }

  private retryOne(transactionId: string, walletId: string, now: Date): Promise<boolean> {
    return this.orm.em.fork().transactional(async (em) => {
      await em.execute(`set local lock_timeout = '5s'`);
      // Same lock order as the submission path: wallet first, then the transaction.
      const walletRecord = await em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const record = await em.findOne(WagerTransactionRecord, { id: transactionId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (
        !walletRecord ||
        !record ||
        record.status !== WagerTransactionStatus.PendingReference ||
        (record.nextReferenceAttemptAt && record.nextReferenceAttemptAt > now)
      ) {
        return false; // another worker already handled it
      }
      const tx = transactionToDomain(record);
      const wallet = walletToDomain(walletRecord);
      const events = { newId, correlationId: tx.id, causationId: tx.id, occurredAt: now };
      const { referenceMissing } = await this.processWager.resolveAndApply(em, tx, wallet, walletRecord, events, now, record);
      if (!referenceMissing) {
        this.metrics.increment('pending_reference_resolved_total');
        this.logger.log({ message: 'Pending reference resolved', transactionId: tx.id, walletId, status: tx.status });
        return true;
      }
      const attempts = record.referenceAttempts + 1;
      const { maxAttempts, baseDelayMs, maxDelayMs } = this.config.pendingReference;
      if (attempts >= maxAttempts) {
        record.referenceAttempts = attempts;
        await this.processWager.rejectMissingReference(em, tx, wallet, events, now, record);
        this.metrics.increment('pending_reference_expired_total');
        this.logger.warn({ message: 'Reference never arrived, transaction rejected', transactionId: tx.id, walletId, attempts });
        return true;
      }
      record.referenceAttempts = attempts;
      record.nextReferenceAttemptAt = new Date(now.getTime() + Math.min(baseDelayMs * 2 ** attempts, maxDelayMs));
      this.metrics.increment('pending_reference_retries_total');
      return false;
    });
  }
}
