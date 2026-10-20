import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ChangeMessageVisibilityCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer.js';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher.js';
import type { AppConfig } from '../../src/config.js';
import { ApiClient, wager } from './api-client.js';
import { freshDatabase, sql } from './support.js';
import { createTestQueues, drain, queueDepth, sendWagerMessage, sqsClient, type TestQueues } from './sqs-support.js';

// Real Postgres and real LocalStack SQS. Workers are driven explicitly so each
// step (receive, commit, ack, publish) can be observed or interrupted.
let orm: MikroORM;
let sqs: SQSClient;
let queues: TestQueues;
let api: ApiClient;
let consumer: WagerConsumer;

const withQueues = (overrides: Partial<AppConfig['consumer']> = {}) => (c: AppConfig): AppConfig => ({
  ...c,
  queues: { transactions: queues.transactions, deadLetter: queues.deadLetter, events: queues.events },
  consumer: { ...c.consumer, enabled: false, waitTimeSeconds: 1, retryBaseSeconds: 0, ...overrides },
});

beforeAll(async () => {
  orm = await freshDatabase();
  sqs = sqsClient();
  queues = await createTestQueues(sqs, 3);
  api = await ApiClient.start(withQueues());
  consumer = api.app.get(WagerConsumer);
});

afterAll(async () => {
  await api.close();
  await orm.close(true);
  sqs.destroy();
});

const messageData = (w: { id: string; playerId: string }, kind: string, amount: string, extra = {}): Record<string, unknown> => {
  const body = wager(w, kind, amount, extra);
  return { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` };
};

const balanceOf = async (walletId: string) => (await api.request('GET', `/wallets/${walletId}`)).body.balance.amount;

const debitsOf = async (walletId: string) =>
  Number(
    (
      await sql<{ n: string }>(orm, `select count(*)::text as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [
        walletId,
      ])
    )[0]?.n,
  );

describe('SQS consumer', () => {
  test('processes a message through the same use case and acks after commit', async () => {
    const wallet = await api.createWallet('100.00');
    await sendWagerMessage(sqs, queues.urls.transactions, 'msg-ok', messageData(wallet, 'BET', '25.00'));
    expect(await consumer.pollOnce()).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
    const inbox = await sql(orm, `select message_id from inbox_messages where message_id = 'msg-ok'`);
    expect(inbox.length).toBe(1);
  });

  test('redelivery of the same message does not duplicate the debit', async () => {
    const wallet = await api.createWallet('100.00');
    const data = messageData(wallet, 'BET', '10.00');
    await sendWagerMessage(sqs, queues.urls.transactions, 'msg-dup', data);
    await sendWagerMessage(sqs, queues.urls.transactions, 'msg-dup', data);
    while ((await consumer.pollOnce()) > 0);
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await debitsOf(wallet.id)).toBe(1);
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
  });

  test('worker dies after commit and before ack: redelivery is a replay, then acked', async () => {
    const wallet = await api.createWallet('100.00');
    await sendWagerMessage(sqs, queues.urls.transactions, 'msg-crash', messageData(wallet, 'BET', '40.00'));
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.urls.transactions,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );
    const message = Messages[0]!;
    // Commit happens here; the "process" then dies, so the message is never deleted.
    expect(await consumer.decide(message)).toEqual({ action: 'ack' });
    expect(await balanceOf(wallet.id)).toBe('60.00');
    // Visibility timeout expires (forced to 0 to keep the test fast).
    await sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: queues.urls.transactions, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }),
    );
    expect(await consumer.pollOnce()).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('60.00');
    expect(await debitsOf(wallet.id)).toBe(1);
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
  });

  test('inbox, transaction, ledger, wallet and outbox commit together or not at all', async () => {
    const wallet = await api.createWallet('100.00');
    // Make the last write of the SQL transaction (the outbox insert) fail in the real database.
    await sql(
      orm,
      `create or replace function fail_balance_event() returns trigger language plpgsql as $$
       begin
         if new.event_type = 'WalletBalanceChanged' then raise exception 'injected outbox failure'; end if;
         return new;
       end; $$`,
    );
    await sql(orm, `create trigger fail_balance_event before insert on outbox_messages for each row execute function fail_balance_event()`);
    const data = messageData(wallet, 'BET', '30.00');
    try {
      await sendWagerMessage(sqs, queues.urls.transactions, 'msg-atomic', data);
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.urls.transactions,
          WaitTimeSeconds: 1,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
      );
      expect((await consumer.decide(Messages[0]!)).action).toBe('retry');
      await sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: queues.urls.transactions, ReceiptHandle: Messages[0]!.ReceiptHandle, VisibilityTimeout: 0 }),
      );
    } finally {
      await sql(orm, `drop trigger fail_balance_event on outbox_messages`);
      await sql(orm, `drop function fail_balance_event()`);
    }
    // Nothing from the failed attempt survived.
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await sql(orm, `select 1 from wager_transactions where external_transaction_id = ?`, [data.externalTransactionId])).toEqual([]);
    expect(await sql(orm, `select 1 from inbox_messages where message_id = 'msg-atomic'`)).toEqual([]);
    expect(await debitsOf(wallet.id)).toBe(0);
    // The redelivery then succeeds as if the first attempt never happened.
    expect(await consumer.pollOnce()).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('70.00');
    expect(await debitsOf(wallet.id)).toBe(1);
  });

  test('a business rejection is terminal: stored as REJECTED and acked', async () => {
    const wallet = await api.createWallet('5.00');
    await sendWagerMessage(sqs, queues.urls.transactions, 'msg-reject', messageData(wallet, 'BET', '10.00'));
    await consumer.pollOnce();
    const [row] = await sql<{ status: string; failure_code: string }>(
      orm,
      `select status, failure_code from wager_transactions where wallet_id = ? and kind = 'BET'`,
      [wallet.id],
    );
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
  });

  test('a permanent failure goes straight to the DLQ', async () => {
    await sendWagerMessage(sqs, queues.urls.transactions, 'msg-bad', '{"not":"a wager"');
    await consumer.pollOnce();
    const dead = await drain(sqs, queues.urls.deadLetter);
    expect(dead.length).toBe(1);
    expect(dead[0]?.MessageAttributes?.failureReason?.StringValue).toContain('malformed');
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
  });

  test('a transient failure is retried with backoff and lands in the DLQ after the limit', async () => {
    // A second instance whose database is unreachable: a real connection failure.
    const broken = await ApiClient.start((c) => ({
      ...withQueues()(c),
      databaseUrl: 'postgresql://wagering:wagering@127.0.0.1:1/wagering',
    }));
    try {
      const brokenConsumer = broken.app.get(WagerConsumer);
      const wallet = await api.createWallet('100.00');
      await sendWagerMessage(sqs, queues.urls.transactions, 'msg-transient', messageData(wallet, 'BET', '1.00'));
      const first = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.urls.transactions,
          WaitTimeSeconds: 1,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
      );
      const decision = await brokenConsumer.decide(first.Messages![0]!);
      expect(decision.action).toBe('retry');
      await brokenConsumer.settle(queues.urls.transactions, first.Messages![0]!, decision);
      // Keep failing until SQS's redrive policy (maxReceiveCount = 3) moves it.
      for (let i = 0; i < 6; i++) {
        await brokenConsumer.pollOnce();
      }
      const dead = await drain(sqs, queues.urls.deadLetter);
      expect(dead.some((m) => m.Body?.includes('msg-transient'))).toBe(true);
      expect(await balanceOf(wallet.id)).toBe('100.00');
    } finally {
      await broken.close();
    }
  });
});

describe('outbox publisher', () => {
  const publishedEventIds = async () => (await drain(sqs, queues.urls.events)).map((m) => m.MessageAttributes?.eventId?.StringValue);

  test('events committed while no publisher ran are published by another instance; two publishers never duplicate', async () => {
    // Commit work with no publisher running (as if the process died right after commit).
    const wallet = await api.createWallet('100.00');
    await Promise.all(Array.from({ length: 12 }, () => api.submit(wager(wallet, 'BET', '1.00'))));
    const pending = await sql<{ id: string }>(orm, `select id from outbox_messages where published_at is null`);
    expect(pending.length).toBeGreaterThan(20);

    const other = await ApiClient.start(withQueues());
    try {
      const a = api.app.get(OutboxPublisher);
      const b = other.app.get(OutboxPublisher);
      let total = 0;
      for (;;) {
        const [x, y] = await Promise.all([a.publishDue(), b.publishDue()]);
        total += x + y;
        if (x + y === 0) break;
      }
      expect(total).toBe(pending.length);
    } finally {
      await other.close();
    }

    const ids = await publishedEventIds();
    expect(ids.length).toBe(pending.length);
    expect(new Set(ids).size).toBe(pending.length);
    expect(new Set(ids)).toEqual(new Set(pending.map((p) => p.id)));
    const left = await sql(orm, `select id from outbox_messages where published_at is null`);
    expect(left.length).toBe(0);
  });

  test('a failed publish is kept and retried with backoff', async () => {
    const wallet = await api.createWallet('10.00');
    await api.submit(wager(wallet, 'BET', '1.00'));
    const failing = await ApiClient.start((c) => ({
      ...withQueues()(c),
      queues: { ...withQueues()(c).queues, events: 'queue-that-does-not-exist' },
    }));
    try {
      expect(await failing.app.get(OutboxPublisher).publishDue()).toBe(0);
    } finally {
      await failing.close();
    }
    const rows = await sql<{ attempts: number; due_later: boolean }>(
      orm,
      `select attempts, next_attempt_at > now() as due_later from outbox_messages where published_at is null`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.attempts === 1 && r.due_later)).toBe(true);

    // Not due yet: nothing is sent.
    const publisher = api.app.get(OutboxPublisher);
    expect(await publisher.publishDue()).toBe(0);
    // Once the backoff elapses, it goes out.
    expect(await publisher.publishDue(new Date(Date.now() + 60_000))).toBe(rows.length);
    expect((await publishedEventIds()).length).toBe(rows.length);
  });
});
