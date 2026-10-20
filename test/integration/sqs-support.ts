import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config.js';

export function sqsClient(): SQSClient {
  const { aws } = loadConfig();
  return new SQSClient({
    region: aws.region,
    endpoint: aws.sqsEndpoint,
    credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey },
  });
}

export interface TestQueues {
  transactions: string;
  deadLetter: string;
  events: string;
  urls: { transactions: string; deadLetter: string; events: string };
}

/** Isolated queues per test file, with the same shape as production (FIFO + DLQ redrive). */
export async function createTestQueues(sqs: SQSClient, maxReceiveCount = 3, visibilityTimeout = 30): Promise<TestQueues> {
  const prefix = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const names = { transactions: `${prefix}.fifo`, deadLetter: `${prefix}-dlq.fifo`, events: `${prefix}-events` };
  const dlq = await sqs.send(
    new CreateQueueCommand({ QueueName: names.deadLetter, Attributes: { FifoQueue: 'true' } }),
  );
  const dlqArn = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: names.transactions,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: String(visibilityTimeout),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn.Attributes?.QueueArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
      },
    }),
  );
  const events = await sqs.send(new CreateQueueCommand({ QueueName: names.events }));
  return {
    ...names,
    urls: { transactions: main.QueueUrl!, deadLetter: dlq.QueueUrl!, events: events.QueueUrl! },
  };
}

export async function sendWagerMessage(
  sqs: SQSClient,
  queueUrl: string,
  messageId: string,
  data: Record<string, unknown> | string,
  dedupId = `${messageId}-${Math.random()}`,
) {
  const body =
    typeof data === 'string'
      ? data
      : JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data });
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: typeof data === 'string' ? 'invalid' : String(data.walletId),
      MessageDeduplicationId: dedupId,
    }),
  );
}

/** Reads everything currently in a queue (without deleting; messages become visible again later). */
export async function drain(sqs: SQSClient, queueUrl: string): Promise<Message[]> {
  const all: Message[] = [];
  for (let empty = 0; empty < 2; ) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 300,
        MessageAttributeNames: ['All'],
      }),
    );
    if (Messages.length === 0) empty += 1;
    all.push(...Messages);
  }
  return all;
}

export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(Attributes.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}
