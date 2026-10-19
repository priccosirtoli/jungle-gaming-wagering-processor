import { Money } from '../money/money.js';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import { BusinessRuleError, InvalidInputError } from '../shared/errors.js';
import { FailureCode } from '../wager/failure-code.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identifies the ledger entry a balance movement produces. */
export interface MovementContext {
  entryId: string;
  transactionId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Required when initialBalance > 0: the internal OPENING transaction and its ledger entry. */
  opening?: { transactionId: string; entryId: string };
  at: Date;
}

/**
 * Aggregate root. Every balance change goes through `apply`, which returns the
 * matching ledger entry, so balance and ledger cannot drift apart in code.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Creates the wallet at version 1. A positive initial balance is recorded as
   * an OPENING credit, so the ledger reconstructs the balance from zero.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidInputError('Initial balance cannot be negative');
    }
    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, initialBalance, 1, at, at);
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    if (!props.opening) {
      throw new Error('An opening transaction is required for a positive initial balance');
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Rebuilds persisted state; does not re-run business validations. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * @param insufficientFundsCode lets reversals report REVERSAL_INSUFFICIENT_FUNDS,
   *        which is operationally different from a BET without funds.
   */
  debit(
    money: Money,
    ctx: MovementContext,
    insufficientFundsCode: FailureCode = FailureCode.InsufficientFunds,
  ): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (this._balance.isLessThan(money)) {
      throw new BusinessRuleError(insufficientFundsCode, 'Insufficient balance');
    }
    return this.apply(LedgerDirection.Debit, money, ctx);
  }

  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, ctx);
  }

  private apply(direction: LedgerDirection, money: Money, ctx: MovementContext): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: ctx.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = ctx.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new BusinessRuleError(
        FailureCode.CurrencyMismatch,
        `Wallet currency is ${this.currency}, operation is ${money.currency}`,
      );
    }
  }
}
