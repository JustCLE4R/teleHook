// Type conversion below reads decorator metadata, so load the polyfill here
// rather than relying on Nest having been imported first.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { IsInt, Matches, Max, Min, validateSync } from 'class-validator';

// class-validator checks decorators bottom-up and stops at the first failure,
// so type checks sit closest to each property.
export class EnvironmentVariables {
  @Max(65535)
  @Min(1)
  @IsInt()
  PORT: number = 3000;

  // The message never includes the value, so a bad token is not echoed to logs.
  @Matches(/^\d+:[\w-]+$/, {
    message:
      'TELEGRAM_BOT_TOKEN must be set to the bot token issued by @BotFather (format: <bot id>:<secret>)',
  })
  TELEGRAM_BOT_TOKEN!: string;

  @Max(100)
  @Min(1)
  @IsInt()
  MAX_RECIPIENTS_PER_REQUEST: number = 20;

  @Max(10)
  @Min(1)
  @IsInt()
  MAX_ATTACHMENTS_PER_REQUEST: number = 5;

  // Telegram accepts uploads of at most 50 MB from bots.
  @Max(50)
  @Min(1)
  @IsInt()
  MAX_ATTACHMENT_SIZE_MB: number = 10;

  @Max(60_000)
  @Min(1_000)
  @IsInt()
  TELEGRAM_REQUEST_TIMEOUT_MS: number = 10_000;

  @Min(1_000)
  @IsInt()
  RATE_LIMIT_TTL_MS: number = 60_000;

  @Min(1)
  @IsInt()
  RATE_LIMIT_MAX_REQUESTS: number = 10;
}

/** Converts and validates environment variables; used by ConfigModule at startup. */
export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(env, { stopAtFirstError: true });
  if (errors.length > 0) {
    const details = errors.flatMap((error) =>
      Object.values(error.constraints ?? {}),
    );
    throw new Error(
      `Invalid environment configuration:\n  - ${details.join('\n  - ')}`,
    );
  }
  return env;
}
