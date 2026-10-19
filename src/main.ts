import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig, type AppConfig } from './config.js';

export async function createApp(config: AppConfig) {
  const app = await NestFactory.create(AppModule.register(config), {
    logger: new ConsoleLogger({ json: true }),
  });
  app.enableShutdownHooks();
  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
}
