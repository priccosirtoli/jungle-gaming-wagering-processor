import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money.js';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry.js';
import { InvalidInputError, InvalidTransactionStateError } from '../../src/domain/shared/errors.js';
import { applyWagerTransaction } from '../../src/domain/wager/apply-wager-transaction.js';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager/wager-transaction.js';
import { NOW, brl, nextId, tx, walletWith } from './fixtures.js';

const apply = (wallet = walletWith('100.00'), t: WagerTransaction, extra: { reference?: WagerTransaction; referenceAlreadyReversed?: boolean } = {}) =>
  applyWagerTransaction(wallet, t, { ledgerEntryId: nextId('entry'), at: NOW, ...extra });

/** A processed transaction to be used as a reference. */
function processed(kind: Kind, amount: string, wallet = walletWith('100.00')) {
  const t = tx(kind, amount);
  const outcome = apply(wallet, t);
  expect(outcome.status).toBe('PROCESSED');
  return t;
}

describe('BET', () => {
  test('debits and records one DEBIT entry', () => {
    const wallet = walletWith('100.00');
    const bet = tx(Kind.Bet, '25.00');
    const outcome = apply(wallet, bet);
    expect(outcome).toMatchObject({ status: 'PROCESSED' });
    if (outcome.status !== 'PROCESSED') throw new Error();
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe('75.00');
    expect(bet.status).toBe(Status.Processed);
    expect(bet.observedBalance?.toString()).toBe('75.00');
  });

  test('is rejected with INSUFFICIENT_FUNDS, no entry, balance untouched', () => {
    const wallet = walletWith('100.00');
    apply(wallet, tx(Kind.Bet, '80.00'));
    const second = tx(Kind.Bet, '80.00');
    expect(apply(wallet, second)).toEqual({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(second.status).toBe(Status.Rejected);
    expect(wallet.balance.toString()).toBe('20.00');
  });

  test('requires a positive amount', () => {
    expect(() => tx(Kind.Bet, '0.00')).toThrow(InvalidInputError);
  });

  test('in another currency is rejected with CURRENCY_MISMATCH', () => {
    const wallet = walletWith('100.00');
    const bet = tx(Kind.Bet, '10.00', { money: Money.from({ amount: '10.00', currency: 'USD' }) });
    expect(apply(wallet, bet)).toEqual({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH' });
    expect(wallet.version).toBe(1);
  });

  test('for another player is rejected with WALLET_PLAYER_MISMATCH', () => {
    const bet = tx(Kind.Bet, '10.00', { playerId: 'someone-else' });
    expect(apply(undefined, bet)).toEqual({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
  });
});

describe('WIN', () => {
  test('credits and records one CREDIT entry', () => {
    const wallet = walletWith('100.00');
    const outcome = apply(wallet, tx(Kind.Win, '50.00'));
    if (outcome.status !== 'PROCESSED') throw new Error();
    expect(outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe('150.00');
  });
});

describe('LOSS', () => {
  test('is processed without touching balance or ledger', () => {
    const wallet = walletWith('100.00');
    const loss = tx(Kind.Loss, '0.00');
    expect(apply(wallet, loss)).toEqual({ status: 'PROCESSED', entry: undefined });
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(loss.affectsBalance()).toBe(false);
  });
});

describe('REFUND', () => {
  test('requires a reference', () => {
    expect(() => tx(Kind.Refund, '10.00')).toThrow(InvalidInputError);
  });

  test('credits back a processed BET', () => {
    const wallet = walletWith('100.00');
    const bet = processed(Kind.Bet, '30.00', wallet);
    const refund = tx(Kind.Refund, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const outcome = apply(wallet, refund, { reference: bet });
    if (outcome.status !== 'PROCESSED') throw new Error();
    expect(outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('only references a BET', () => {
    const win = processed(Kind.Win, '10.00');
    const refund = tx(Kind.Refund, '10.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(apply(undefined, refund, { reference: win })).toEqual({
      status: 'REJECTED',
      failureCode: 'REFERENCE_KIND_NOT_ALLOWED',
    });
  });

  test('cannot be applied twice to the same BET', () => {
    const bet = processed(Kind.Bet, '10.00');
    const refund = tx(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(apply(undefined, refund, { reference: bet, referenceAlreadyReversed: true })).toEqual({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
  });

  test('must match the referenced amount', () => {
    const bet = processed(Kind.Bet, '10.00');
    const refund = tx(Kind.Refund, '5.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(apply(undefined, refund, { reference: bet })).toEqual({ status: 'REJECTED', failureCode: 'AMOUNT_MISMATCH' });
  });

  test('must be in the same round', () => {
    const bet = processed(Kind.Bet, '10.00');
    const refund = tx(Kind.Refund, '10.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
      roundId: 'round-2',
    });
    expect(apply(undefined, refund, { reference: bet })).toEqual({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
  });

  test('cannot revert a rejected BET', () => {
    const wallet = walletWith('5.00');
    const bet = tx(Kind.Bet, '10.00');
    apply(wallet, bet);
    expect(bet.status).toBe(Status.Rejected);
    const refund = tx(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(apply(wallet, refund, { reference: bet })).toEqual({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_PROCESSED',
    });
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits', () => {
    const wallet = walletWith('100.00');
    const bet = processed(Kind.Bet, '40.00', wallet);
    const rollback = tx(Kind.Rollback, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const outcome = apply(wallet, rollback, { reference: bet });
    if (outcome.status !== 'PROCESSED') throw new Error();
    expect(outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('of a WIN debits', () => {
    const wallet = walletWith('100.00');
    const win = processed(Kind.Win, '40.00', wallet);
    const rollback = tx(Kind.Rollback, '40.00', { referenceExternalTransactionId: win.externalTransactionId });
    const outcome = apply(wallet, rollback, { reference: win });
    if (outcome.status !== 'PROCESSED') throw new Error();
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('of a WIN that would go negative is rejected with its own code', () => {
    const wallet = walletWith('0.00');
    const win = processed(Kind.Win, '50.00', wallet);
    apply(wallet, tx(Kind.Bet, '45.00'));
    const rollback = tx(Kind.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(apply(wallet, rollback, { reference: win })).toEqual({
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
    });
    expect(wallet.balance.toString()).toBe('5.00');
  });

  test('cannot reference a LOSS', () => {
    const loss = processed(Kind.Loss, '0.00');
    const rollback = tx(Kind.Rollback, '0.01', { referenceExternalTransactionId: loss.externalTransactionId });
    expect(apply(undefined, rollback, { reference: loss })).toEqual({
      status: 'REJECTED',
      failureCode: 'REFERENCE_KIND_NOT_ALLOWED',
    });
  });
});

describe('WagerTransaction state machine', () => {
  test('starts PENDING and OPENING cannot be submitted', () => {
    expect(tx(Kind.Bet, '1.00').status).toBe(Status.Pending);
    expect(() => tx(Kind.Opening, '1.00')).toThrow(InvalidInputError);
  });

  test('PENDING_REFERENCE can still be processed', () => {
    const t = tx(Kind.Refund, '1.00', { referenceExternalTransactionId: 'later' });
    t.markPendingReference();
    t.markPendingReference();
    expect(t.status).toBe(Status.PendingReference);
    t.reject('REFERENCE_NOT_FOUND', NOW);
    expect(t.status).toBe(Status.Rejected);
  });

  test.each([
    ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, NOW, brl('0.00'))],
    ['REJECTED', (t: WagerTransaction) => t.reject('INSUFFICIENT_FUNDS', NOW)],
    ['FAILED', (t: WagerTransaction) => t.fail('INFRASTRUCTURE_FAILURE', NOW)],
  ])('%s is terminal', (_, finish) => {
    const t = tx(Kind.Bet, '1.00');
    finish(t);
    expect(t.isTerminal()).toBe(true);
    expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => t.markProcessed(undefined, NOW, brl('0.00'))).toThrow(InvalidTransactionStateError);
    expect(() => t.reject('INSUFFICIENT_FUNDS', NOW)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail('INFRASTRUCTURE_FAILURE', NOW)).toThrow(InvalidTransactionStateError);
  });

  test('same idempotency key with a different payload hash does not match', () => {
    const t = tx(Kind.Bet, '1.00', { payloadHash: 'abc' });
    expect(t.matchesPayload('abc')).toBe(true);
    expect(t.matchesPayload('def')).toBe(false);
  });
});
