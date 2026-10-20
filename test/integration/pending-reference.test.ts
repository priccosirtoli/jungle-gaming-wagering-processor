import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PendingReferenceWorker } from '../../src/application/pending-reference.worker.js';
import { ApiClient, wager } from './api-client.js';
import { freshDatabase, sql } from './support.js';

let orm: MikroORM;
let api: ApiClient;
let worker: PendingReferenceWorker;
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

beforeAll(async () => {
  orm = await freshDatabase();
  api = await ApiClient.start((c) => ({ ...c, pendingReference: { ...c.pendingReference, enabled: false, maxAttempts: 3 } }));
  worker = api.app.get(PendingReferenceWorker);
});

afterAll(async () => {
  await api.close();
  await orm.close(true);
});

describe('reversal delivered before its reference', () => {
  test('REFUND waits as PENDING_REFERENCE and is applied once the BET arrives', async () => {
    const wallet = await api.createWallet('100.00');
    const bet = wager(wallet, 'BET', '30.00');
    const refund = await api.submit(wager(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.status).toBe(202);

    // Not due yet: nothing happens.
    expect(await worker.retryDue()).toBe(0);

    await api.submit(bet);
    expect((await api.request('GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe('70.00');

    expect(await worker.retryDue(later(1))).toBe(1);
    const stored = await api.request('GET', `/wagering/transactions/${refund.body.transactionId}`);
    expect(stored.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    expect((await api.request('GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe('100.00');

    // A replay of the original request now returns the final outcome.
    const replay = await api.submit(wager(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId, externalTransactionId: stored.body.externalTransactionId }));
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });

    const reconciliation = await api.request('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(reconciliation.body.consistent).toBe(true);
  });

  test('ROLLBACK whose reference never arrives is rejected with REFERENCE_NOT_FOUND after the retry limit', async () => {
    const wallet = await api.createWallet('100.00');
    const rollback = await api.submit(wager(wallet, 'ROLLBACK', '10.00', { referenceExternalTransactionId: 'never-sent' }));
    expect(rollback.status).toBe(202);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await worker.retryDue(later(attempt * 10));
    }
    const stored = await api.request('GET', `/wagering/transactions/${rollback.body.transactionId}`);
    expect(stored.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND', balance: { amount: '100.00' } });

    const events = await sql<{ event_type: string }>(
      orm,
      `select event_type from outbox_messages where aggregate_id = ? order by seq`,
      [rollback.body.transactionId],
    );
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
  });
});
