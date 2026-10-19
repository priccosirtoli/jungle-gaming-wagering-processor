import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money.js';
import { BusinessRuleError, InvalidInputError } from '../../src/domain/shared/errors.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('always serializes with 2 decimal places', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(brl('0').toString()).toBe('0.00');
  });

  test('is exact where floats are not', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('100.00').subtract(brl('80.00')).subtract(brl('19.99')).toString()).toBe('0.01');
  });

  test('handles the largest numeric(20,2) value', () => {
    const max = brl('999999999999999999.99');
    expect(max.toString()).toBe('999999999999999999.99');
    expect(max.subtract(brl('0.01')).toString()).toBe('999999999999999999.98');
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E-2'],
    [''],
    [' 1.00'],
    ['1.001'],
    ['-1.00'],
    ['01.00'],
    ['1.'],
    ['.50'],
    ['1,00'],
    ['0x10'],
    ['1000000000000000000.00'],
  ])('rejects invalid amount %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidInputError);
  });

  test('rejects non-string amounts at runtime', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidInputError);
  });

  test.each([['brl'], ['BR'], ['BRLX'], [''], ['R$']])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidInputError);
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('15.00');
    expect(a.negate().toString()).toBe('-10.00');
    expect(a.toString()).toBe('10.00');
  });

  test('comparisons', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('1.0').equals(brl('1.00'))).toBe(true);
  });

  test('operations across currencies are a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(BusinessRuleError);
    expect(() => brl('1.00').subtract(usd)).toThrow(BusinessRuleError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(BusinessRuleError);
    expect(brl('1.00').equals(usd)).toBe(false);
    try {
      brl('1.00').add(usd);
    } catch (error) {
      expect((error as BusinessRuleError).failureCode).toBe('CURRENCY_MISMATCH');
    }
  });
});
