export interface AppConfig {
  port: number;
  databaseUrl: string;
  aws: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sqsEndpoint: string | undefined;
  };
  queues: {
    transactions: string;
    deadLetter: string;
    /** Where the outbox publisher sends integration events. */
    events: string;
  };
  consumer: {
    enabled: boolean;
    name: string;
    /** SQS long-poll wait. */
    waitTimeSeconds: number;
    /** Transient failures back off by changing visibility: base * 2^(receiveCount-1), capped. */
    retryBaseSeconds: number;
    retryMaxSeconds: number;
    /** How long SIGTERM waits for an in-flight message before giving up. */
    shutdownGraceMs: number;
  };
  outbox: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
  };
  /**
   * Reversals waiting for their reference are retried with exponential backoff
   * (base * 2^attempt, capped). After maxAttempts they are REJECTED with
   * REFERENCE_NOT_FOUND. Defaults give roughly a 6 minute window.
   */
  pendingReference: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const flag = (name: string, fallback: boolean) => (process.env[name] ?? String(fallback)) === 'true';
const int = (name: string, fallback: number) => Number(required(name, String(fallback)));

export function loadConfig(): AppConfig {
  return {
    port: int('PORT', 3000),
    databaseUrl: required('DATABASE_URL', 'postgresql://wagering:wagering@localhost:5432/wagering'),
    aws: {
      region: required('AWS_REGION', 'us-east-1'),
      accessKeyId: required('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: required('AWS_SECRET_ACCESS_KEY', 'test'),
      sqsEndpoint: process.env.SQS_ENDPOINT || undefined,
    },
    queues: {
      transactions: required('SQS_QUEUE_NAME', 'wager-transactions.fifo'),
      deadLetter: required('SQS_DLQ_NAME', 'wager-transactions-dlq.fifo'),
      events: required('SQS_EVENTS_QUEUE_NAME', 'wagering-events'),
    },
    consumer: {
      enabled: flag('CONSUMER_ENABLED', true),
      name: required('CONSUMER_NAME', 'wager-transactions-consumer'),
      waitTimeSeconds: int('CONSUMER_WAIT_SECONDS', 10),
      retryBaseSeconds: int('CONSUMER_RETRY_BASE_SECONDS', 2),
      retryMaxSeconds: int('CONSUMER_RETRY_MAX_SECONDS', 300),
      shutdownGraceMs: int('CONSUMER_SHUTDOWN_GRACE_MS', 10_000),
    },
    outbox: {
      enabled: flag('OUTBOX_ENABLED', true),
      intervalMs: int('OUTBOX_INTERVAL_MS', 500),
      batchSize: int('OUTBOX_BATCH_SIZE', 50),
    },
    pendingReference: {
      enabled: flag('PENDING_REFERENCE_ENABLED', true),
      intervalMs: int('PENDING_REFERENCE_INTERVAL_MS', 1000),
      batchSize: int('PENDING_REFERENCE_BATCH_SIZE', 50),
      maxAttempts: int('PENDING_REFERENCE_MAX_ATTEMPTS', 10),
      baseDelayMs: int('PENDING_REFERENCE_BASE_DELAY_MS', 1000),
      maxDelayMs: int('PENDING_REFERENCE_MAX_DELAY_MS', 60_000),
    },
  };
}
