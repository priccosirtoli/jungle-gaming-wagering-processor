import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/main.js';
import { loadConfig } from '../../src/config.js';

// Runs against the real Postgres and LocalStack from docker-compose.
describe('health', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createApp({ ...loadConfig(), port: 0 });
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  test('live responds without touching dependencies', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'up' });
  });

  test('ready reports Postgres and SQS reachable', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'up', checks: { postgres: 'up', sqs: 'up' } });
  });
});
