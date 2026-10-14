import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { rateLimitMessage } from './rate-limit-message.js';

/** Limits every route to RATE_LIMIT_MAX_REQUESTS per client IP per window. */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        throttlers: [
          {
            ttl: config.get('RATE_LIMIT_TTL_MS', { infer: true }),
            limit: config.get('RATE_LIMIT_MAX_REQUESTS', { infer: true }),
          },
        ],
        // timeToBlockExpire is the wait in seconds that Retry-After also gives.
        errorMessage: (_context, { timeToBlockExpire }) =>
          rateLimitMessage(timeToBlockExpire),
      }),
    }),
  ],
  // An APP_GUARD applies to the whole app, whichever module provides it.
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RateLimitModule {}
