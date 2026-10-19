import { Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from './config.js';
import { APP_CONFIG } from './tokens.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { MessagingModule } from './infrastructure/messaging/messaging.module.js';
import { HealthController } from './health/health.controller.js';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule, MessagingModule],
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
