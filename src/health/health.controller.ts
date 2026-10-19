import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG } from '../tokens.js';
import type { AppConfig } from '../config.js';

type CheckStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 2000;

/** Health endpoints are intentionally unauthenticated. */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'up' } {
    return { status: 'up' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      this.check(async () => {
        await this.orm.em.getConnection().execute('select 1');
      }),
      this.check(async () => {
        await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.queues.transactions }));
      }),
    ]);
    const status: CheckStatus = postgres === 'up' && sqs === 'up' ? 'up' : 'down';
    res.status(status === 'up' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status, checks: { postgres, sqs } };
  }

  private async check(probe: () => Promise<void>): Promise<CheckStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
        }),
      ]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
