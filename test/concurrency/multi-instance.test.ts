import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { freshDatabase, sql } from '../integration/support.js';
import { createTestQueues, drain, queueDepth, sendWagerMessage, sqsClient, type TestQueues } from '../integration/sqs-support.js';

/*
 * Real parallelism across processes: three (then four) separate `bun` processes
 * running the full service (HTTP, SQS consumer, outbox publisher, pending
 * reference worker) against one Postgres and one LocalStack. No in-process
 * shortcuts: every request crosses HTTP or SQS.
 */

interface Instance {
  port: number;
  proc: Subprocess;
  url: string;
}

let orm: MikroORM;
let sqs: SQSClient;
let queues: TestQueues;
const instances: Instance[] = [];
const wallets: string[] = [];
let nextPort = 4100;

async function startInstance(): Promise<Instance> {
  const port = nextPort++;
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      SQS_QUEUE_NAME: queues.transactions,
      SQS_DLQ_NAME: queues.deadLetter,
      SQS_EVENTS_QUEUE_NAME: queues.events,
      CONSUMER_WAIT_SECONDS: '1',
      CONSUMER_RETRY_BASE_SECONDS: '1',
      OUTBOX_INTERVAL_MS: '200',
      PENDING_REFERENCE_INTERVAL_MS: '200',
      PENDING_REFERENCE_BASE_DELAY_MS: '200',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/health/ready`)).status === 200) {
        const instance = { port, proc, url };
        instances.push(instance);
        return instance;
      }
    } catch {
      // not listening yet
    }
    await Bun.sleep(200);
  }
  proc.kill();
  throw new Error(`instance on port ${port} did not become ready`);
}

async function call(instance: Instance, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${instance.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function createWallet(amount: string) {
  const res = await call(instances[0]!, 'POST', '/wallets', {
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(res.status).toBe(201);
  wallets.push(res.body.id);
  return res.body as { id: string; playerId: string };
}

let seq = 0;
function wager(w: { id: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  const externalTransactionId = `mi-${Date.now()}-${seq}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

const submit = (instance: Instance, body: ReturnType<typeof wager>) =>
  call(instance, 'POST', '/wagering/transactions', body, { 'idempotency-key': body.idempotencyKey });

const balance = async (walletId: string) => (await call(instances.at(-1)!, 'GET', `/wallets/${walletId}`)).body.balance.amount;

const debits = async (walletId: string) =>
  Number(
    (await sql<{ n: string }>(orm, `select count(*)::text as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]))[0]?.n,
  );

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(250);
  }
  throw new Error('condition not reached in time');
}

const queueIsEmpty = async () => {
  const depth = await queueDepth(sqs, queues.urls.transactions);
  return depth.visible === 0 && depth.inFlight === 0;
};

beforeAll(async () => {
  orm = await freshDatabase();
  sqs = sqsClient();
  queues = await createTestQueues(sqs, 5, 5);
  await Promise.all([startInstance(), startInstance(), startInstance()]);
});

afterAll(async () => {
  // Final invariant for every wallet: stored balance == balance rebuilt from the ledger.
  for (const walletId of wallets) {
    const res = await call(instances.at(-1)!, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(res.body.consistent).toBe(true);
  }
  for (const instance of instances) {
    instance.proc.kill('SIGTERM');
  }
  await Promise.all(instances.map((i) => i.proc.exited));
  await orm.close(true);
  sqs.destroy();
});

describe('three instances', () => {
  test('hot wallet hammered through all instances never overdraws', async () => {
    const wallet = await createWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => submit(instances[i % 3]!, wager(wallet, 'BET', '5.00'))),
    );
    expect(results.filter((r) => r.body.status === 'PROCESSED').length).toBe(20);
    expect(results.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS').length).toBe(40);
    expect(await balance(wallet.id)).toBe('0.00');
    expect(await debits(wallet.id)).toBe(20);
  });

  test('the same bet sent 50 times across instances debits once', async () => {
    const wallet = await createWallet('100.00');
    const bet = wager(wallet, 'BET', '9.99');
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(instances[i % 3]!, bet)));
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false).length).toBe(1);
    expect(await balance(wallet.id)).toBe('90.01');
    expect(await debits(wallet.id)).toBe(1);
  });

  test('three consumers share the queue; duplicated messages apply once', async () => {
    const targets = await Promise.all(Array.from({ length: 4 }, () => createWallet('50.00')));
    const sends: Promise<void>[] = [];
    for (const w of targets) {
      for (let i = 0; i < 10; i++) {
        const data = wager(w, 'BET', '1.50');
        const messageId = `msg-${data.externalTransactionId}`;
        sends.push(sendWagerMessage(sqs, queues.urls.transactions, messageId, data));
        sends.push(sendWagerMessage(sqs, queues.urls.transactions, messageId, data)); // duplicate delivery
      }
    }
    await Promise.all(sends);
    await waitFor(queueIsEmpty);
    for (const w of targets) {
      expect(await balance(w.id)).toBe('35.00');
      expect(await debits(w.id)).toBe(10);
    }
  });

  test('a reversal that arrives before its reference is resolved by whichever instance retries it', async () => {
    const wallet = await createWallet('40.00');
    const bet = wager(wallet, 'BET', '15.00');
    const rollback = wager(wallet, 'ROLLBACK', '15.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect((await submit(instances[1]!, rollback)).status).toBe(202);
    expect((await submit(instances[2]!, bet)).status).toBe(200);
    await waitFor(async () => (await balance(wallet.id)) === '40.00');
    const stored = await call(instances[0]!, 'GET', `/providers/provider-a/wagering/transactions/${rollback.externalTransactionId}`);
    expect(stored.body.status).toBe('PROCESSED');
  });
});

describe('crash and restart', () => {
  test('killing an instance mid-load loses nothing and duplicates nothing', async () => {
    const targets = await Promise.all(Array.from({ length: 3 }, () => createWallet('100.00')));
    const sends: Promise<void>[] = [];
    for (const w of targets) {
      for (let i = 0; i < 20; i++) {
        const data = wager(w, 'BET', '2.00');
        sends.push(sendWagerMessage(sqs, queues.urls.transactions, `msg-${data.externalTransactionId}`, data));
      }
    }
    await Promise.all(sends);

    // Kill one instance without any chance to clean up (no SIGTERM handling),
    // possibly between a commit and the ack, or between a commit and the publish.
    await Bun.sleep(300);
    const victim = instances[0]!;
    victim.proc.kill('SIGKILL');
    await victim.proc.exited;
    instances.splice(0, 1);

    // A fresh instance joins (restart); messages the victim held reappear after the visibility timeout.
    await startInstance();
    await waitFor(queueIsEmpty, 90_000);

    for (const w of targets) {
      expect(await balance(w.id)).toBe('60.00');
      expect(await debits(w.id)).toBe(20);
    }

    // Every committed event is eventually published; delivery may repeat, never miss.
    await waitFor(async () => (await sql(orm, `select 1 from outbox_messages where published_at is null limit 1`)).length === 0);
    const outboxIds = (await sql<{ id: string }>(orm, `select id from outbox_messages`)).map((r) => r.id);
    const publishedIds = new Set((await drain(sqs, queues.urls.events)).map((m) => m.MessageAttributes?.eventId?.StringValue));
    for (const id of outboxIds) {
      expect(publishedIds.has(id)).toBe(true);
    }
  });
});
