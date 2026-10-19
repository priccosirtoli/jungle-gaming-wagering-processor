import { Money, type MoneyProps } from '../domain/money/money.js';
import { WagerTransactionKind } from '../domain/wager/wager-transaction.js';
import { ValidationError } from './errors.js';
import { payloadHash } from './payload-hash.js';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID_LENGTH = 200;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ID_LENGTH) {
    throw new ValidationError(`${field} must be a non-empty string up to ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

function uuid(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (!isUuid(value)) {
    throw new ValidationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function money(value: unknown, field: string): Money {
  const props = record(value, field);
  return Money.from({ amount: props.amount, currency: props.currency } as MoneyProps);
}

/** Validates an incoming wager (HTTP body or SQS `data`). OPENING is not submittable. */
export function parseSubmitWager(input: unknown, idempotencyKey: unknown): SubmitWagerCommand {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '' || idempotencyKey.length > MAX_ID_LENGTH) {
    throw new ValidationError('Idempotency-Key is required');
  }
  const body = record(input, 'body');
  const kind = body.kind;
  if (typeof kind !== 'string' || !SUBMITTABLE_KINDS.has(kind)) {
    throw new ValidationError(`kind must be one of ${[...SUBMITTABLE_KINDS].join(', ')}`);
  }
  const reference = body.referenceExternalTransactionId;
  if (reference !== undefined && reference !== null && (typeof reference !== 'string' || reference.trim() === '')) {
    throw new ValidationError('referenceExternalTransactionId must be a non-empty string');
  }
  return {
    idempotencyKey,
    providerId: text(body, 'providerId'),
    externalTransactionId: text(body, 'externalTransactionId'),
    playerId: uuid(body, 'playerId'),
    walletId: uuid(body, 'walletId'),
    roundId: text(body, 'roundId'),
    gameId: text(body, 'gameId'),
    kind: kind as WagerTransactionKind,
    money: money(body.money, 'money'),
    referenceExternalTransactionId: typeof reference === 'string' ? reference : undefined,
  };
}

export function parseCreateWallet(input: unknown): CreateWalletCommand {
  const body = record(input, 'body');
  return { playerId: uuid(body, 'playerId'), initialBalance: money(body.initialBalance, 'initialBalance') };
}

/**
 * Hash of the business fields only: the idempotency key and transport
 * metadata are excluded. Amounts are normalized ("25" and "25.00" hash the same).
 */
export function hashWagerCommand(cmd: SubmitWagerCommand): string {
  return payloadHash({
    providerId: cmd.providerId,
    externalTransactionId: cmd.externalTransactionId,
    playerId: cmd.playerId,
    walletId: cmd.walletId,
    roundId: cmd.roundId,
    gameId: cmd.gameId,
    kind: cmd.kind,
    money: cmd.money.toJSON(),
    referenceExternalTransactionId: cmd.referenceExternalTransactionId,
  });
}
