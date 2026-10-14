import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { validateEnv } from './config/env.validation.js';
import { LoggingModule } from './logging/logging.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    RateLimitModule,
    LoggingModule,
    NotificationsModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        stopAtFirstError: true,
      }),
    },
  ],
})
export class AppModule {}
