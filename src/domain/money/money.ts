import Decimal from 'decimal.js';
import { BusinessRuleError, InvalidInputError } from '../shared/errors.js';
import { FailureCode } from '../wager/failure-code.js';

/** DTO used in every contract: decimal string with 2 places, ISO-4217 code. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

// Isolated Decimal constructor so global configuration cannot leak in.
// Only add/subtract are used, so with 2-place inputs no rounding ever happens.
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const SCALE = 2;
/** numeric(20,2) in Postgres leaves 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;
const AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})(\\.\\d{1,${SCALE}})?$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Parses an input contract. Rejects NaN, Infinity, scientific notation,
   * empty strings, more than 2 decimal places and negative values.
   */
  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidInputError(
        `Invalid amount "${String(props?.amount)}": expected a non-negative decimal string with up to ${SCALE} places`,
      );
    }
    return new Money(new Dec(props.amount), Money.assertCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(new Dec(0), Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Always 2 decimal places, e.g. "25.00". */
  toString(): string {
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new BusinessRuleError(
        FailureCode.CurrencyMismatch,
        `Currency mismatch: ${this.currency} vs ${other.currency}`,
      );
    }
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidInputError(`Invalid currency "${String(currency)}": expected an ISO-4217 code`);
    }
    return currency;
  }
}
