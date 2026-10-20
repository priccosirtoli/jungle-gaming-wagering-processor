/**
 * End-to-end demo against a running stack (docker compose --profile app up --scale app=3).
 * Talks to the service only through HTTP and SQS and prints a readable report;
 * on GitHub Actions the report also goes to the job summary.
 *
 *   bun run demo
 */
import { appendFileSync } from 'node:fs';
import { SendMessageCommand, SQSClient, GetQueueUrlCommand } from '@aws-sdk/client-sqs';

const instances = (process.env.DEMO_URLS ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002')
  .split(',')
  .map((u) => u.trim());
const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const report: string[] = [];
let failures = 0;
const out = (line = '') => {
  report.push(line);
  console.log(line);
};
const check = (label: string, ok: boolean, detail: string) => {
  if (!ok) failures += 1;
  out(`| ${ok ? '✅' : '❌'} | ${label} | ${detail} |`);
};

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, instance = 0) {
  const res = await fetch(`${instances[instance % instances.length]}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined } as { status: number; body: any };
}

let n = 0;
const wager = (w: { id: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) => {
  n += 1;
  const externalTransactionId = `demo-${Date.now()}-${n}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
};
const submit = (body: ReturnType<typeof wager>, instance = 0, key = `${body.providerId}:${body.externalTransactionId}`) =>
  call('POST', '/wagering/transactions', body, { 'idempotency-key': key }, instance);

async function newWallet(amount: string) {
  const res = await call('POST', '/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  return res.body as { id: string; playerId: string; balance: { amount: string }; version: number };
}
const balance = async (id: string) => (await call('GET', `/wallets/${id}`)).body.balance.amount as string;

out('## Demo do Distributed Wagering Processor');
out();
out(`Instâncias: ${instances.join(', ')}`);
out();
out('| | Cenário | Resultado |');
out('|---|---|---|');

// Health
for (const [i] of instances.entries()) {
  const ready = await call('GET', '/health/ready', undefined, {}, i);
  check(`Instância ${i + 1} pronta`, ready.status === 200, JSON.stringify(ready.body.checks));
}

// Wallet + BET
const w1 = await newWallet('1000.00');
check('Criar wallet com 1000.00', w1.balance?.amount === '1000.00' && w1.version === 1, `saldo ${w1.balance?.amount}, version ${w1.version}`);
const bet = wager(w1, 'BET', '25.00');
const r1 = await submit(bet);
check('BET de 25.00', r1.status === 200 && r1.body.balance.amount === '975.00', `HTTP ${r1.status}, ${r1.body.status}, saldo ${r1.body.balance.amount}`);

// Idempotency
const r2 = await submit(bet, 1);
check('Mesma requisição de novo (outra instância)', r2.body.idempotentReplay === true && r2.body.transactionId === r1.body.transactionId, `HTTP ${r2.status}, idempotentReplay=${r2.body.idempotentReplay}`);
const r3 = await submit({ ...bet, money: { amount: '30.00', currency: 'BRL' } }, 2);
check('Mesma chave com outro valor', r3.status === 409, `HTTP ${r3.status} ${r3.body.error?.code}`);
const r4 = await call('POST', '/wagering/transactions', { ...bet, money: { amount: '1e3', currency: 'BRL' } }, { 'idempotency-key': 'x' });
check('Valor inválido ("1e3")', r4.status === 400, `HTTP ${r4.status} ${r4.body.error?.code}`);

// Mandatory race: 100.00, two 80.00 at the same time on different instances
const w2 = await newWallet('100.00');
const race = await Promise.all([submit(wager(w2, 'BET', '80.00'), 0), submit(wager(w2, 'BET', '80.00'), 1)]);
const statuses = race.map((r) => r.body.status).sort().join(' + ');
check('100.00 e duas BETs de 80.00 simultâneas', statuses === 'PROCESSED + REJECTED' && (await balance(w2.id)) === '20.00', `${statuses}, saldo final ${await balance(w2.id)}`);

// Same bet 50x across instances
const w3 = await newWallet('100.00');
const same = wager(w3, 'BET', '7.00');
const fifty = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(same, i)));
const originals = fifty.filter((r) => r.body.idempotentReplay === false).length;
check('Mesma BET 50x em paralelo nas 3 instâncias', originals === 1 && (await balance(w3.id)) === '93.00', `${originals} processada, ${50 - originals} replays, saldo ${await balance(w3.id)}`);

// Reversals
const w4 = await newWallet('100.00');
const lateBet = wager(w4, 'BET', '40.00');
const early = await submit(wager(w4, 'REFUND', '40.00', { referenceExternalTransactionId: lateBet.externalTransactionId }));
check('REFUND antes da BET', early.status === 202, `HTTP ${early.status} ${early.body.status}`);
await submit(lateBet);
let refunded = '';
for (let i = 0; i < 40 && refunded !== '100.00'; i++) {
  await Bun.sleep(250);
  refunded = await balance(w4.id);
}
check('Worker aplica o REFUND quando a BET chega', refunded === '100.00', `saldo ${refunded}`);

// SQS
const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }))).QueueUrl!;
const w5 = await newWallet('50.00');
const data = { ...wager(w5, 'BET', '10.00') };
const message = {
  messageId: `msg-${data.externalTransactionId}`,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
};
for (const dedup of ['a', 'b']) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: w5.id,
      MessageDeduplicationId: `${message.messageId}-${dedup}`,
    }),
  );
}
let viaSqs = '';
for (let i = 0; i < 60 && viaSqs !== '40.00'; i++) {
  await Bun.sleep(250);
  viaSqs = await balance(w5.id);
}
await Bun.sleep(2000);
viaSqs = await balance(w5.id);
check('Mensagem SQS enviada 2x (mesmo messageId)', viaSqs === '40.00', `saldo ${viaSqs} (um único débito)`);

// Reconciliation
for (const w of [w1, w2, w3, w4, w5]) {
  const rec = await call('POST', `/wallets/${w.id}/reconciliation`);
  check(`Reconciliação wallet ${w.id.slice(0, 8)}`, rec.body.consistent === true, `saldo ${rec.body.storedBalance.amount} = ledger ${rec.body.calculatedBalance.amount} (${rec.body.checkedEntries} lançamentos)`);
}

// Metrics sample
const metrics = await (await fetch(`${instances[0]}/metrics`)).text();
out();
out('<details><summary>Amostra de /metrics (instância 1)</summary>');
out();
out('```');
out(metrics.split('\n').filter((l) => /^(wager_transactions_total|duplicates_detected_total|inbox_duplicates_total|outbox_)/.test(l)).join('\n'));
out('```');
out('</details>');
out();
out(failures === 0 ? '**Todos os cenários passaram.**' : `**${failures} cenário(s) falharam.**`);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.join('\n')}\n`);
}
sqs.destroy();
process.exit(failures === 0 ? 0 : 1);
