import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ApiClient, wager } from './api-client.js';
import { freshDatabase, sql } from './support.js';

// Real Postgres (and LocalStack for readiness) from docker-compose; no mocks.
let api: ApiClient;
let orm: MikroORM;
const createdWallets: string[] = [];

beforeAll(async () => {
  orm = await freshDatabase();
  api = await ApiClient.start();
});

afterAll(async () => {
  // Invariant for every wallet touched by this file: balance == ledger.
  for (const walletId of createdWallets) {
    const res = await api.request('POST', `/wallets/${walletId}/reconciliation`);
    expect(res.body.consistent).toBe(true);
  }
  await api.close();
  await orm.close(true);
});

async function newWallet(amount: string) {
  const wallet = await api.createWallet(amount);
  createdWallets.push(wallet.id);
  return wallet;
}

async function ledgerOf(walletId: string) {
  return sql<{ direction: string; amount: string; balance_after: string }>(
    orm,
    `select direction, amount::text, balance_after::text from wallet_ledger_entries where wallet_id = ? order by seq`,
    [walletId],
  );
}

describe('wallets', () => {
  test('creation records an OPENING credit at version 1', async () => {
    const wallet = await newWallet('1000.00');
    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(await ledgerOf(wallet.id)).toEqual([{ direction: 'CREDIT', amount: '1000.00', balance_after: '1000.00' }]);
  });

  test('a second wallet for the same player and currency is a conflict', async () => {
    const wallet = await newWallet('10.00');
    const res = await api.request('POST', '/wallets', {
      playerId: wallet.playerId,
      initialBalance: { amount: '5.00', currency: 'BRL' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('zero initial balance has no ledger entry', async () => {
    const wallet = await newWallet('0.00');
    expect(await ledgerOf(wallet.id)).toEqual([]);
  });

  test('unknown wallet is 404', async () => {
    const res = await api.request('GET', `/wallets/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('submitting transactions', () => {
  test('BET is processed and the response carries the new balance', async () => {
    const wallet = await newWallet('1000.00');
    const res = await api.submit(wager(wallet, 'BET', '25.00'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
    const walletNow = await api.request('GET', `/wallets/${wallet.id}`);
    expect(walletNow.body.version).toBe(2);
  });

  test('identical retry is a replay with the original result', async () => {
    const wallet = await newWallet('100.00');
    const bet = wager(wallet, 'BET', '10.00');
    const first = await api.submit(bet);
    await api.submit(wager(wallet, 'BET', '5.00'));
    const again = await api.submit(bet);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, idempotentReplay: true });
    // Original observed balance, not the current one.
    expect(again.body.balance.amount).toBe('90.00');
    expect((await ledgerOf(wallet.id)).length).toBe(3);
  });

  test('same key with another payload is a conflict, not a replay', async () => {
    const wallet = await newWallet('100.00');
    const bet = wager(wallet, 'BET', '10.00');
    await api.submit(bet);
    const res = await api.submit({ ...bet, money: { amount: '11.00', currency: 'BRL' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('amounts are normalized before hashing ("10" equals "10.00")', async () => {
    const wallet = await newWallet('100.00');
    const bet = wager(wallet, 'BET', '10.00');
    await api.submit(bet);
    const res = await api.submit({ ...bet, money: { amount: '10', currency: 'BRL' } });
    expect(res.body.idempotentReplay).toBe(true);
  });

  test('payload problems are 400 and nothing is stored', async () => {
    const wallet = await newWallet('100.00');
    const cases: Array<[Record<string, unknown>, Record<string, string>?]> = [
      [wager(wallet, 'BET', '1.001')],
      [wager(wallet, 'BET', '1e2')],
      [wager(wallet, 'BET', '-5.00')],
      [wager(wallet, 'OPENING', '5.00')],
      [wager(wallet, 'REFUND', '5.00')],
      [{ ...wager(wallet, 'BET', '5.00'), money: { amount: 5, currency: 'BRL' } }],
    ];
    for (const [body] of cases) {
      const res = await api.submit(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAYLOAD');
    }
    const missingKey = await api.request('POST', '/wagering/transactions', wager(wallet, 'BET', '1.00'));
    expect(missingKey.status).toBe(400);
    expect((await ledgerOf(wallet.id)).length).toBe(1);
  });

  test('insufficient funds is a 422 rejection, stored for audit, with no ledger entry', async () => {
    const wallet = await newWallet('10.00');
    const res = await api.submit(wager(wallet, 'BET', '10.01'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    const stored = await api.request('GET', `/wagering/transactions/${res.body.transactionId}`);
    expect(stored.body.status).toBe('REJECTED');
    expect((await ledgerOf(wallet.id)).length).toBe(1);
  });

  test('currency mismatch is rejected', async () => {
    const wallet = await newWallet('10.00');
    const res = await api.submit(wager(wallet, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('LOSS is processed without moving money', async () => {
    const wallet = await newWallet('10.00');
    const res = await api.submit(wager(wallet, 'LOSS', '0.00'));
    expect(res.status).toBe(200);
    expect(res.body.balance.amount).toBe('10.00');
    expect((await api.request('GET', `/wallets/${wallet.id}`)).body.version).toBe(1);
  });

  test('lookup by provider and external id', async () => {
    const wallet = await newWallet('10.00');
    const bet = wager(wallet, 'BET', '1.00');
    await api.submit(bet);
    const res = await api.request('GET', `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '1.00' } });
  });
});

describe('reversals', () => {
  test('REFUND credits a BET once', async () => {
    const wallet = await newWallet('100.00');
    const bet = wager(wallet, 'BET', '30.00');
    await api.submit(bet);
    const refund = await api.submit(wager(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.status).toBe(200);
    expect(refund.body.balance.amount).toBe('100.00');
    const second = await api.submit(wager(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  });

  test('ROLLBACK of a WIN that would go negative has its own failure code', async () => {
    const wallet = await newWallet('0.00');
    const win = wager(wallet, 'WIN', '50.00');
    await api.submit(win);
    await api.submit(wager(wallet, 'BET', '45.00'));
    const rollback = await api.submit(wager(wallet, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
  });

  test('REFUND before its BET is accepted as PENDING_REFERENCE (202)', async () => {
    const wallet = await newWallet('100.00');
    const res = await api.submit(wager(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: 'not-yet' }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' } });
  });
});

describe('ledger pagination', () => {
  test('cursor walks every entry once, in order', async () => {
    const wallet = await newWallet('100.00');
    for (let i = 0; i < 5; i++) {
      await api.submit(wager(wallet, 'BET', '1.00'));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = await api.request('GET', `/wallets/${wallet.id}/ledger${query}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.entries.map((e: { balanceAfter: { amount: string } }) => e.balanceAfter.amount));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['100.00', '99.00', '98.00', '97.00', '96.00', '95.00']);
    expect((await api.request('GET', `/wallets/${wallet.id}/ledger?cursor=garbage`)).status).toBe(400);
  });
});

describe('outbox', () => {
  test('events are written with the change; WalletBalanceChanged only when the balance moves', async () => {
    const wallet = await newWallet('10.00');
    const bet = await api.submit(wager(wallet, 'BET', '1.00'));
    const loss = await api.submit(wager(wallet, 'LOSS', '0.00'));
    const rejected = await api.submit(wager(wallet, 'BET', '100.00'));
    const types = async (id: string) =>
      (await sql<{ event_type: string }>(orm, `select event_type from outbox_messages where aggregate_id = ? order by seq`, [id])).map(
        (r) => r.event_type,
      );
    expect(await types(bet.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await types(loss.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await types(rejected.body.transactionId)).toEqual(['WagerTransactionRejected']);
    expect(await types(wallet.id)).toEqual(['WalletBalanceChanged', 'WalletBalanceChanged']);
  });
});

describe('concurrency', () => {
  test('100.00 and two simultaneous 80.00 bets: one processed, one rejected, balance 20.00', async () => {
    const wallet = await newWallet('100.00');
    const results = await Promise.all([api.submit(wager(wallet, 'BET', '80.00')), api.submit(wager(wallet, 'BET', '80.00'))]);
    const statuses = results.map((r) => r.body.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.body.status === 'REJECTED')?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await api.request('GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe('20.00');
    const debits = (await ledgerOf(wallet.id)).filter((e) => e.direction === 'DEBIT');
    expect(debits).toEqual([{ direction: 'DEBIT', amount: '80.00', balance_after: '20.00' }]);
  });

  test('the same bet sent 50 times in parallel debits once', async () => {
    const wallet = await newWallet('100.00');
    const bet = wager(wallet, 'BET', '7.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => api.submit(bet)));
    expect(results.every((r) => r.status === 200 && r.body.status === 'PROCESSED')).toBe(true);
    expect(results.filter((r) => !r.body.idempotentReplay).length).toBe(1);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => r.body.balance.amount === '93.00')).toBe(true);
    expect((await ledgerOf(wallet.id)).filter((e) => e.direction === 'DEBIT').length).toBe(1);
  });

  test('many bets racing for one hot wallet never overdraw it', async () => {
    const wallet = await newWallet('50.00');
    const results = await Promise.all(Array.from({ length: 30 }, () => api.submit(wager(wallet, 'BET', '3.00'))));
    expect(results.filter((r) => r.body.status === 'PROCESSED').length).toBe(16);
    expect(results.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS').length).toBe(14);
    expect((await api.request('GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe('2.00');
  });

  test('different wallets are processed in parallel and stay consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => newWallet('20.00')));
    const results = await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 5 }, () => api.submit(wager(w, 'BET', '2.50')))),
    );
    expect(results.every((r) => r.body.status === 'PROCESSED')).toBe(true);
    for (const w of wallets) {
      expect((await api.request('GET', `/wallets/${w.id}`)).body.balance.amount).toBe('7.50');
    }
  });
});
