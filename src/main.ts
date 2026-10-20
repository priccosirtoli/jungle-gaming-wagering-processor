import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig, type AppConfig } from './config.js';
import { JsonLogger } from './infrastructure/observability/json-logger.js';

export async function createApp(config: AppConfig) {
  const app = await NestFactory.create(AppModule.register(config), { logger: new JsonLogger() });
  // SIGTERM/SIGINT run the shutdown hooks: workers stop polling, finish or hand
  // back in-flight work, then the database pool and SQS client close.
  app.enableShutdownHooks();
  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
}
