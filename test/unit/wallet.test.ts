import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry.js';
import { BusinessRuleError, InvalidInputError } from '../../src/domain/shared/errors.js';
import { NOW, PLAYER_ID, WALLET_ID, brl, walletWith } from './fixtures.js';

const movement = (n: number) => ({ entryId: `e${n}`, transactionId: `t${n}`, at: NOW });

describe('Wallet', () => {
  test('opens at version 1 with an OPENING credit for a positive balance', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl('1000.00'),
      opening: { transactionId: 'opening-tx', entryId: 'opening-entry' },
      at: NOW,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
  });

  test('opens with zero balance and no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl('0.00'),
      at: NOW,
    });
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test('debit and credit return balanced ledger entries and bump the version', () => {
    const wallet = walletWith('100.00');
    const debit = wallet.debit(brl('80.00'), movement(1));
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);

    const credit = wallet.credit(brl('5.50'), movement(2));
    expect(credit.balanceAfter.toString()).toBe('25.50');
    expect(wallet.balance.toString()).toBe('25.50');
    expect(wallet.version).toBe(3);
  });

  test('never goes negative and does not change on rejection', () => {
    const wallet = walletWith('100.00');
    wallet.debit(brl('80.00'), movement(1));
    expect(() => wallet.debit(brl('80.00'), movement(2))).toThrow(BusinessRuleError);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('can spend the exact balance', () => {
    const wallet = walletWith('80.00');
    wallet.debit(brl('80.00'), movement(1));
    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('rejects operations in another currency', () => {
    const wallet = walletWith('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit(usd, movement(1))).toThrow(BusinessRuleError);
    expect(() => wallet.debit(usd, movement(2))).toThrow(BusinessRuleError);
    expect(wallet.version).toBe(1);
  });

  test('rejects zero-amount movements', () => {
    const wallet = walletWith('100.00');
    expect(() => wallet.credit(brl('0.00'), movement(1))).toThrow(InvalidInputError);
  });

  test('ledger reconstructs the balance', () => {
    const wallet = walletWith('100.00');
    const entries = [
      wallet.debit(brl('30.00'), movement(1)),
      wallet.credit(brl('12.34'), movement(2)),
      wallet.debit(brl('0.01'), movement(3)),
    ];
    const replayed = entries.reduce((acc, e) => acc.add(e.signedAmount()), brl('100.00'));
    expect(replayed.equals(wallet.balance)).toBe(true);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: WALLET_ID,
    transactionId: 't',
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('50.00'),
    balanceAfter: brl('40.00'),
    createdAt: NOW,
  };

  test('accepts balanced arithmetic', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
  });

  test('rejects unbalanced arithmetic', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('41.00') })).toThrow(InvalidInputError);
  });

  test('rejects a negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceBefore: brl('5.00'), balanceAfter: brl('5.00').subtract(brl('10.00')) }),
    ).toThrow(InvalidInputError);
  });

  test('is frozen at runtime, not only readonly at compile time', () => {
    const entry = WalletLedgerEntry.create(base) as unknown as { balanceAfter: unknown };
    expect(() => {
      entry.balanceAfter = brl('0.00');
    }).toThrow(TypeError);
  });
});
