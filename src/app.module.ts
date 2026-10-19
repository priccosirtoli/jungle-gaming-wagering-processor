import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { AppConfig } from './config.js';
import { APP_CONFIG } from './tokens.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { MessagingModule } from './infrastructure/messaging/messaging.module.js';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher.js';
import { WagerConsumer } from './infrastructure/messaging/wager-consumer.js';
import { Metrics } from './infrastructure/observability/metrics.js';
import { HealthController } from './health/health.controller.js';
import { MetricsController } from './health/metrics.controller.js';
import { ProcessWagerService } from './application/process-wager.service.js';
import { WalletService } from './application/wallet.service.js';
import { WageringController, WalletsController } from './http/controllers.js';
import { ErrorFilter } from './http/error.filter.js';
import { ProviderAuthGuard } from './http/auth.guard.js';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule, MessagingModule],
      controllers: [HealthController, MetricsController, WalletsController, WageringController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ErrorFilter },
        Metrics,
        ProviderAuthGuard,
        ProcessWagerService,
        WalletService,
        WagerConsumer,
        OutboxPublisher,
      ],
      exports: [APP_CONFIG, Metrics],
    };
  }
}
