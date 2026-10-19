import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  test('uses the FIFO queue names from the challenge by default', () => {
    delete process.env.SQS_QUEUE_NAME;
    delete process.env.SQS_DLQ_NAME;
    expect(loadConfig().queues).toEqual({
      transactions: 'wager-transactions.fifo',
      deadLetter: 'wager-transactions-dlq.fifo',
    });
  });

  test('treats an empty SQS endpoint as unset', () => {
    process.env.SQS_ENDPOINT = '';
    expect(loadConfig().aws.sqsEndpoint).toBeUndefined();
  });
});
