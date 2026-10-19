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
  };
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(required('PORT', '3000')),
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
    },
  };
}
