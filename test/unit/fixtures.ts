import { Money } from '../../src/domain/money/money.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager/wager-transaction.js';

export const NOW = new Date('2026-10-20T12:00:00.000Z');
export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

let sequence = 0;
export const nextId = (prefix = 'id') => `${prefix}-${++sequence}`;

export function walletWith(amount: string, currency = 'BRL'): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount, currency }),
    opening: { transactionId: nextId('opening'), entryId: nextId('entry') },
    at: NOW,
  }).wallet;
}

export function tx(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return WagerTransaction.create({
    id: nextId('tx'),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'hash',
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    createdAt: NOW,
    ...overrides,
  });
}
