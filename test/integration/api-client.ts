import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/main.js';
import { loadConfig, type AppConfig } from '../../src/config.js';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export class ApiClient {
  private constructor(
    readonly app: INestApplication,
    private readonly baseUrl: string,
  ) {}

  /** Background workers are off unless a test turns them on and drives them explicitly. */
  static async start(overrides: (config: AppConfig) => AppConfig = (c) => c): Promise<ApiClient> {
    const base = loadConfig();
    const config = overrides({
      ...base,
      port: 0,
      consumer: { ...base.consumer, enabled: false },
      outbox: { ...base.outbox, enabled: false },
    });
    const app = await createApp(config);
    await app.listen(0, '127.0.0.1');
    return new ApiClient(app, await app.getUrl());
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  async createWallet(amount: string, currency = 'BRL', playerId: string = crypto.randomUUID()) {
    const res = await this.request('POST', '/wallets', { playerId, initialBalance: { amount, currency } });
    if (res.status !== 201) {
      throw new Error(`createWallet failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
  }

  submit(wager: Record<string, unknown>, idempotencyKey = `${wager.providerId}:${wager.externalTransactionId}`) {
    return this.request('POST', '/wagering/transactions', wager, { 'idempotency-key': idempotencyKey });
  }

  close() {
    return this.app.close();
  }
}

let counter = 0;

export function wager(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  counter += 1;
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${Date.now()}-${counter}-${Math.random().toString(36).slice(2)}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}
