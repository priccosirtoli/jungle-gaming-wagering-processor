import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { freshDatabase, sql } from './support.js';

// The invariants must hold even if application code is bypassed.
describe('schema constraints', () => {
  let orm: MikroORM;
  let n = 0;
  const id = () => crypto.randomUUID();

  beforeAll(async () => {
    orm = await freshDatabase();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(() => {
    n += 1;
  });

  async function insertWallet(balance = '100.00', playerId = id()) {
    const walletId = id();
    await sql(
      orm,
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, 'BRL', ?, 1, now(), now())`,
      [walletId, playerId, balance],
    );
    return { walletId, playerId };
  }

  async function insertTransaction(
    walletId: string,
    playerId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row: Record<string, unknown> = {
      id: id(),
      provider_id: 'provider-a',
      external_transaction_id: `ext-${n}-${id()}`,
      idempotency_key: `key-${n}-${id()}`,
      payload_hash: 'a'.repeat(64),
      wallet_id: walletId,
      player_id: playerId,
      round_id: 'round-1',
      game_id: 'game-1',
      kind: 'BET',
      amount: '10.00',
      currency: 'BRL',
      status: 'PENDING',
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    };
    const cols = Object.keys(row);
    await sql(
      orm,
      `insert into wager_transactions (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`,
      Object.values(row),
    );
    return row.id as string;
  }

  async function insertEntry(walletId: string, transactionId: string, before: string, amount: string, after: string, direction = 'DEBIT') {
    await sql(
      orm,
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, 'BRL', ?, ?, now())`,
      [id(), walletId, transactionId, direction, amount, before, after],
    );
  }

  test('migrations are reversible', async () => {
    await orm.migrator.down({ to: 0 });
    const afterDown = await sql<{ count: string }>(
      orm,
      `select count(*) from information_schema.tables where table_schema = 'public' and table_name in
         ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages')`,
    );
    expect(Number(afterDown[0]?.count)).toBe(0);
    await orm.migrator.up();
  });

  test('one wallet per player and currency', async () => {
    const { playerId } = await insertWallet();
    await expect(insertWallet('0.00', playerId)).rejects.toThrow(/wallets_player_currency_unique/);
  });

  test('balance can never be negative', async () => {
    const { walletId } = await insertWallet('10.00');
    await expect(sql(orm, `update wallets set balance = balance - 10.01 where id = ?`, [walletId])).rejects.toThrow(
      /wallets_balance_check/,
    );
  });

  test('money columns keep exactly 2 decimal places', async () => {
    const { walletId } = await insertWallet('0.10');
    await sql(orm, `update wallets set balance = balance + 0.20 where id = ?`, [walletId]);
    const [row] = await sql<{ balance: string }>(orm, `select balance from wallets where id = ?`, [walletId]);
    expect(row?.balance).toBe('0.30');
  });

  test('idempotency key and provider external id are unique', async () => {
    const { walletId, playerId } = await insertWallet();
    await insertTransaction(walletId, playerId, { idempotency_key: 'dup-key', external_transaction_id: 'ext-a' });
    await expect(insertTransaction(walletId, playerId, { idempotency_key: 'dup-key' })).rejects.toThrow(
      /wager_transactions_idempotency_key_unique/,
    );
    await expect(insertTransaction(walletId, playerId, { external_transaction_id: 'ext-a' })).rejects.toThrow(
      /wager_transactions_provider_external_unique/,
    );
  });

  test('reversals require a reference', async () => {
    const { walletId, playerId } = await insertWallet();
    await expect(insertTransaction(walletId, playerId, { kind: 'REFUND' })).rejects.toThrow(
      /wager_transactions_reversal_needs_reference/,
    );
  });

  test('a reference is reverted at most once per kind', async () => {
    const { walletId, playerId } = await insertWallet();
    const bet = await insertTransaction(walletId, playerId, { status: 'PROCESSED' });
    const refund = (ext: string) =>
      insertTransaction(walletId, playerId, {
        kind: 'REFUND',
        status: 'PROCESSED',
        reference_external_transaction_id: 'bet-ext',
        reference_transaction_id: bet,
        external_transaction_id: ext,
      });
    await refund('refund-1');
    await expect(refund('refund-2')).rejects.toThrow(/wager_transactions_single_reversal_per_kind/);
  });

  test('terminal transactions cannot change', async () => {
    const { walletId, playerId } = await insertWallet();
    const txId = await insertTransaction(walletId, playerId, { status: 'PROCESSED' });
    await expect(sql(orm, `update wager_transactions set status = 'PENDING' where id = ?`, [txId])).rejects.toThrow(
      /is terminal/,
    );
  });

  test('ledger entries must be balanced', async () => {
    const { walletId, playerId } = await insertWallet();
    const txId = await insertTransaction(walletId, playerId);
    await expect(insertEntry(walletId, txId, '100.00', '10.00', '91.00')).rejects.toThrow(/wallet_ledger_entries_balanced/);
  });

  test('at most one ledger entry per transaction', async () => {
    const { walletId, playerId } = await insertWallet();
    const txId = await insertTransaction(walletId, playerId);
    await insertEntry(walletId, txId, '100.00', '10.00', '90.00');
    await expect(insertEntry(walletId, txId, '90.00', '10.00', '80.00')).rejects.toThrow(
      /wallet_ledger_entries_one_per_transaction/,
    );
  });

  test('ledger is append-only: no update, delete or truncate', async () => {
    const { walletId, playerId } = await insertWallet();
    const txId = await insertTransaction(walletId, playerId);
    await insertEntry(walletId, txId, '100.00', '10.00', '90.00');
    await expect(sql(orm, `update wallet_ledger_entries set amount = 1 where transaction_id = ?`, [txId])).rejects.toThrow(
      /append-only/,
    );
    await expect(sql(orm, `delete from wallet_ledger_entries where transaction_id = ?`, [txId])).rejects.toThrow(
      /append-only/,
    );
    await expect(sql(orm, `truncate wallet_ledger_entries cascade`)).rejects.toThrow(/append-only/);
  });

  test('inbox deduplicates by consumer and message id', async () => {
    const insert = () =>
      sql(
        orm,
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('c', 'msg-1', ?, now())`,
        ['b'.repeat(64)],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/inbox_messages_pkey/);
  });
});
