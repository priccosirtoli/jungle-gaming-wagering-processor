import { Inject, Injectable, Logger, type OnApplicationBootstrap, type BeforeApplicationShutdown } from '@nestjs/common';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/outbox/outbox-message.js';
import { APP_CONFIG } from '../../tokens.js';
import type { AppConfig } from '../../config.js';
import { Metrics } from '../observability/metrics.js';
import { QueueUrls } from './queue-urls.js';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
}

/** SendMessageBatch accepts at most 10 entries. */
const SQS_BATCH = 10;

/**
 * Publishes committed outbox rows. Safe with many publishers (instances) at once:
 * each claims due rows with FOR UPDATE SKIP LOCKED inside its own transaction,
 * so two publishers never take the same row, and rows of a publisher that dies
 * mid-way are unlocked by Postgres and picked up by another one.
 *
 * Delivery is at-least-once: if the process dies after SQS accepted a message
 * but before the commit that marks it published, it is sent again. Consumers
 * deduplicate by `eventId` (also sent as a message attribute).
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly queueUrls: QueueUrls;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = false;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {
    this.queueUrls = new QueueUrls(sqs);
  }

  onApplicationBootstrap(): void {
    if (this.config.outbox.enabled) {
      this.schedule(0);
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
      this.running = this.publishDue()
        .catch((error) => this.logger.error({ message: 'Outbox cycle failed', error: String(error) }))
        .finally(() => this.schedule(this.config.outbox.intervalMs));
    }, delayMs);
  }

  /** One cycle: claim due rows, publish them, record the outcome. Returns how many were published. */
  async publishDue(now = new Date()): Promise<number> {
    const em = this.orm.em.fork();
    const published = await em.transactional(async (tx) => {
      const rows = await tx.execute<OutboxRow[]>(
        `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
           from outbox_messages
          where published_at is null and next_attempt_at <= ?
          order by seq
          limit ?
          for update skip locked`,
        [now, this.config.outbox.batchSize],
      );
      if (rows.length === 0) return 0;
      const messages = rows.map((r) =>
        OutboxMessage.rehydrate({
          id: r.id,
          aggregateId: r.aggregate_id,
          eventType: r.event_type,
          payload: r.payload,
          occurredAt: new Date(r.occurred_at),
          attempts: r.attempts,
          nextAttemptAt: new Date(r.next_attempt_at),
        }),
      );
      const ok = await this.send(messages);
      for (const message of messages) {
        if (ok.has(message.id)) {
          message.markPublished(now);
        } else {
          message.scheduleRetry(now);
          this.metrics.increment('outbox_publish_retries_total');
        }
        await this.save(tx, message);
      }
      return ok.size;
    });
    await this.recordLag(em);
    return published;
  }

  private async send(messages: OutboxMessage[]): Promise<Set<string>> {
    const ok = new Set<string>();
    let queueUrl: string;
    try {
      queueUrl = await this.queueUrls.get(this.config.queues.events);
    } catch (error) {
      this.logger.warn({ message: 'Events queue unavailable', error: String(error) });
      return ok;
    }
    for (let i = 0; i < messages.length; i += SQS_BATCH) {
      const chunk = messages.slice(i, i + SQS_BATCH);
      try {
        const result = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((m, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(m.payload),
              MessageAttributes: {
                eventId: { DataType: 'String', StringValue: m.id },
                eventType: { DataType: 'String', StringValue: m.eventType },
              },
            })),
          }),
        );
        for (const success of result.Successful ?? []) {
          const message = chunk[Number(success.Id)];
          if (message) ok.add(message.id);
        }
        for (const failure of result.Failed ?? []) {
          this.logger.warn({ message: 'Outbox entry rejected by SQS', eventId: chunk[Number(failure.Id)]?.id, code: failure.Code });
        }
      } catch (error) {
        this.logger.warn({ message: 'Outbox batch publish failed', error: String(error) });
      }
    }
    this.metrics.increment('outbox_published_total', ok.size);
    return ok;
  }

  private async save(em: EntityManager, m: OutboxMessage): Promise<void> {
    await em.execute(`update outbox_messages set attempts = ?, next_attempt_at = ?, published_at = ? where id = ?`, [
      m.attempts,
      m.nextAttemptAt ?? m.occurredAt,
      m.publishedAt ?? null,
      m.id,
    ]);
  }

  private async recordLag(em: EntityManager): Promise<void> {
    const [row] = await em.execute<{ lag_seconds: string | null; pending: string }[]>(
      `select extract(epoch from now() - min(occurred_at))::text as lag_seconds, count(*)::text as pending
         from outbox_messages where published_at is null`,
    );
    this.metrics.set('outbox_lag_seconds', Number(row?.lag_seconds ?? 0));
    this.metrics.set('outbox_pending', Number(row?.pending ?? 0));
  }
}
