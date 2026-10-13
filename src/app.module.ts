import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import {
  type EnvironmentVariables,
  validateEnv,
} from './config/env.validation.js';
import { NotificationsModule } from './notifications/notifications.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        throttlers: [
          {
            ttl: config.get('RATE_LIMIT_TTL_MS', { infer: true }),
            limit: config.get('RATE_LIMIT_MAX_REQUESTS', { infer: true }),
          },
        ],
        errorMessage: 'Too many requests, please try again later',
      }),
    }),
    NotificationsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
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
