import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { EnvironmentVariables } from './config/env.validation.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.disable('x-powered-by');
  app.enableShutdownHooks();

  const config: ConfigService<EnvironmentVariables, true> =
    app.get(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  Logger.log(`Listening on port ${port}`, 'Bootstrap');
}
await bootstrap();
