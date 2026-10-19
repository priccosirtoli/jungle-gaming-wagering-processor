import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { parseSubmitWager } from '../../application/commands.js';
import { IdempotencyConflictError, NotFoundError, ValidationError } from '../../application/errors.js';
import { payloadHash } from '../../application/payload-hash.js';
import { ProcessWagerService } from '../../application/process-wager.service.js';
import { InvalidInputError } from '../../domain/shared/errors.js';
import { APP_CONFIG } from '../../tokens.js';
import type { AppConfig } from '../../config.js';
import { isTransient } from '../../http/error.filter.js';
import { Metrics } from '../observability/metrics.js';
import { QueueUrls } from './queue-urls.js';

export const MESSAGE_TYPE = 'WagerTransactionRequested';

/**
 * - ack: the outcome is committed (processed, rejected, pending reference or replay); delete.
 * - retry: transient failure; keep the message and back off via visibility. After
 *   maxReceiveCount the queue's redrive policy moves it to the DLQ.
 * - dead-letter: permanent failure (malformed, unknown wallet, idempotency conflict);
 *   retrying cannot help, so it goes straight to the DLQ.
 */
export type Decision =
  | { action: 'ack' }
  | { action: 'retry'; reason: string }
  | { action: 'dead-letter'; reason: string };

interface Envelope {
  messageId: string;
  type: string;
  occurredAt?: string;
  data: Record<string, unknown>;
}

@Injectable()
export class WagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WagerConsumer.name);
  private readonly queueUrls: QueueUrls;
  private stopping = false;
  private abort = new AbortController();
  private loop: Promise<void> | undefined;
  private inFlight: Promise<unknown> | undefined;

  constructor(
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(ProcessWagerService) private readonly processWager: ProcessWagerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {
    this.queueUrls = new QueueUrls(sqs);
  }

  onApplicationBootstrap(): void {
    if (this.config.consumer.enabled) {
      this.loop = this.run();
    }
  }

  /**
   * SIGTERM: stop polling, let the message in progress finish (bounded by a grace
   * period) and hand every message not yet started back to the queue.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    const grace = new Promise((resolve) => setTimeout(resolve, this.config.consumer.shutdownGraceMs));
    await Promise.race([Promise.allSettled([this.inFlight, this.loop]), grace]);
  }

  /** Long-polls until shutdown. */
  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const handled = await this.pollOnce();
        if (handled === 0 && this.config.consumer.waitTimeSeconds === 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        if (this.stopping) break;
        this.logger.error({ message: 'Consumer poll failed', error: String(error) });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /** Receives one batch and handles it in order. Returns how many messages were received. */
  async pollOnce(): Promise<number> {
    const queueUrl = await this.queueUrls.get(this.config.queues.transactions);
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.config.consumer.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.abort.signal },
    );
    for (const [index, message] of Messages.entries()) {
      if (this.stopping) {
        await this.release(queueUrl, Messages.slice(index));
        break;
      }
      const work = this.handle(queueUrl, message);
      this.inFlight = work;
      await work;
    }
    return Messages.length;
  }

  async handle(queueUrl: string, message: Message): Promise<Decision> {
    const decision = await this.decide(message);
    await this.settle(queueUrl, message, decision);
    return decision;
  }

  /** Runs the use case (which commits). Does not touch the queue. */
  async decide(message: Message): Promise<Decision> {
    const started = performance.now();
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(message.Body);
    } catch (error) {
      return { action: 'dead-letter', reason: `malformed message: ${(error as Error).message}` };
    }
    const log = { messageId: envelope.messageId, providerId: envelope.data.providerId, walletId: envelope.data.walletId };
    try {
      const command = parseSubmitWager(envelope.data, envelope.data.idempotencyKey);
      const result = await this.processWager.execute(command, {
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
        inbox: {
          consumerName: this.config.consumer.name,
          messageId: envelope.messageId,
          payloadHash: payloadHash(envelope.data),
        },
      });
      this.logger.log({
        message: 'Wager message processed',
        ...log,
        transactionId: result.transaction.id,
        status: result.transaction.status,
        failureCode: result.transaction.failureCode,
        replay: result.idempotentReplay,
        durationMs: Math.round(performance.now() - started),
      });
      return { action: 'ack' };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof InvalidInputError ||
        error instanceof NotFoundError ||
        error instanceof IdempotencyConflictError
      ) {
        return { action: 'dead-letter', reason: `${error.name}: ${error.message}` };
      }
      // Transient by classification, or unknown: retry; the redrive policy bounds attempts.
      const reason = isTransient(error) ? `transient: ${String(error)}` : `unexpected: ${String(error)}`;
      this.logger.warn({ message: 'Wager message will be retried', ...log, reason });
      return { action: 'retry', reason };
    }
  }

  /** ack only after the use case committed; retries back off; permanent failures go to the DLQ. */
  async settle(queueUrl: string, message: Message, decision: Decision): Promise<void> {
    switch (decision.action) {
      case 'ack':
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
        return;
      case 'retry': {
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
        const { retryBaseSeconds, retryMaxSeconds } = this.config.consumer;
        const delay = Math.min(retryBaseSeconds * 2 ** (receiveCount - 1), retryMaxSeconds);
        this.metrics.increment('consumer_retries_total');
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: delay,
          }),
        );
        return;
      }
      case 'dead-letter': {
        const dlqUrl = await this.queueUrls.get(this.config.queues.deadLetter);
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: dlqUrl,
            MessageBody: message.Body ?? '',
            MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
            MessageDeduplicationId: message.MessageId,
            MessageAttributes: { failureReason: { DataType: 'String', StringValue: decision.reason.slice(0, 1000) } },
          }),
        );
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
        this.metrics.increment('dlq_messages_total', 1, { reason: 'permanent' });
        this.logger.warn({ message: 'Wager message sent to DLQ', sqsMessageId: message.MessageId, reason: decision.reason });
        return;
      }
    }
  }

  /** Makes messages visible again immediately so another instance can take them. */
  private async release(queueUrl: string, messages: Message[]): Promise<void> {
    await Promise.allSettled(
      messages.map((m) =>
        this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 })),
      ),
    );
  }
}

function parseEnvelope(body: string | undefined): Envelope {
  const parsed = JSON.parse(body ?? '') as Partial<Envelope>;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('body is not an object');
  if (typeof parsed.messageId !== 'string' || parsed.messageId === '') throw new Error('messageId is required');
  if (parsed.type !== MESSAGE_TYPE) throw new Error(`unsupported type ${String(parsed.type)}`);
  if (typeof parsed.data !== 'object' || parsed.data === null) throw new Error('data is required');
  return parsed as Envelope;
}
