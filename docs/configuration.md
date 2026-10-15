# Configuration

All configuration comes from environment variables, validated once at startup by `validateEnv()` in `src/config/env.validation.ts`. There are no config files besides `.env`, and no runtime reconfiguration.

## Sources and precedence

1. **Real environment variables** (shell, systemd, Docker, CI) take precedence.
2. **`.env`** in the **current working directory**, loaded by `@nestjs/config`. It is not resolved relative to the project, so start the app from the project root, or set `WorkingDirectory` in systemd.
3. **Defaults** declared on `EnvironmentVariables`.

`.env` is git-ignored (`.env`, `.env.*`, except `.env.example`). `.env.example` is the documented template.

## Variables

| Variable                      | Type    | Default      | Allowed             | Used by                    | Effect                                                                                                         |
| ----------------------------- | ------- | ------------ | ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`          | string  | **required** | `^\d+:[\w-]+$`      | `TelegramService`          | Bot token from @BotFather, `<bot id>:<secret>`. Part of every Bot API URL.                                     |
| `PORT`                        | integer | `3000`       | 1–65535             | `main.ts`                  | HTTP port. The server listens on all interfaces.                                                               |
| `MAX_RECIPIENTS_PER_REQUEST`  | integer | `20`         | 1–100               | `NotificationsService`     | Maximum `chat_ids` per request (400 above it).                                                                 |
| `MAX_ATTACHMENTS_PER_REQUEST` | integer | `5`          | 1–10                | `MultipartFormInterceptor` | Maximum files per request (multer `files` limit).                                                              |
| `MAX_ATTACHMENT_SIZE_MB`      | integer | `10`         | 1–50                | `MultipartFormInterceptor` | Maximum size per file, in MiB (× 1024 × 1024). Telegram accepts bot uploads up to 50 MB.                       |
| `TELEGRAM_REQUEST_TIMEOUT_MS` | integer | `10000`      | 1000–60000          | `TelegramService`          | Timeout for each attempt of each Bot API call, uploads included.                                               |
| `TELEGRAM_MAX_RETRIES`        | integer | `3`          | 0–10                | `TelegramService`          | Retries after a temporary failure. `0` = never retry (no duplicates, but more lost alerts).                    |
| `ERROR_LOG_DIR`               | string  | `logs`       | any; empty disables | `ErrorFileLogger`          | Directory for `errors-YYYY-MM-DD.jsonl`, resolved against the working directory. Created on the first warning. |
| `ERROR_LOG_RETENTION_DAYS`    | integer | `30`         | 1–3650              | `ErrorFileLogger`          | Error-log files older than this many days are deleted.                                                         |
| `RATE_LIMIT_TTL_MS`           | integer | `60000`      | ≥ 1000              | `RateLimitModule`          | Rate-limit window.                                                                                             |
| `RATE_LIMIT_MAX_REQUESTS`     | integer | `10`         | ≥ 1                 | `RateLimitModule`          | Requests per client IP per window.                                                                             |

Unknown variables are ignored, so other tools can share the same `.env`. `test/fire.sh` reads `TELEHOOK_API_URL` and `TELEHOOK_CHAT_IDS` from it, and the server ignores them.

### Derived limits worth knowing

| Quantity                         | Formula                                                  | With defaults               |
| -------------------------------- | -------------------------------------------------------- | --------------------------- |
| Peak upload memory per request   | about 2 × files × size (multer buffer + one `Blob` copy) | ≈ 100 MB                    |
| Upload bandwidth per request     | chats × files × size                                     | up to 20 × 5 × 10 MB = 1 GB |
| Worst-case time per Bot API call | (1 + retries) × timeout + (2^retries − 1) s              | 47 s                        |
| Bot API calls per request        | chats × (1 + files) (+ retries, fallbacks)               | up to 120                   |

## Startup validation

`validateEnv(config)`:

1. `plainToInstance(EnvironmentVariables, config, { enableImplicitConversion: true })` converts strings to numbers using the declared types (`"8080"` → `8080`), and applies defaults for missing values.
2. `validateSync(env, { stopAtFirstError: true })`: one message per invalid variable.
3. Any errors throw:

```text
Invalid environment configuration:
  - TELEGRAM_BOT_TOKEN must be set to the bot token issued by @BotFather (format: <bot id>:<secret>)
  - PORT must not be greater than 65535
```

Nest fails to start and the process exits with code 1.

Messages come from class-validator's defaults, except for the token:

| Constraint    | Message                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| token pattern | `TELEGRAM_BOT_TOKEN must be set to the bot token issued by @BotFather (format: <bot id>:<secret>)`. It never includes the value, so a bad token is not echoed to logs. |
| `@IsInt`      | `<NAME> must be an integer number` (e.g. `"2.5"`, `"twenty"`)                                                                                                          |
| `@Min(n)`     | `<NAME> must not be less than <n>`                                                                                                                                     |
| `@Max(n)`     | `<NAME> must not be greater than <n>`                                                                                                                                  |
| `@IsString`   | `<NAME> must be a string`                                                                                                                                              |

Decorators run bottom-up, and validation stops at the first failure per property, so the type check (`@IsInt`) sits closest to the property and reports first.

Edge cases:

- An empty numeric variable (`PORT=`) converts to `0`, so the `@Min` message is reported.
- `ERROR_LOG_DIR=` (empty) is valid and disables the error-log files.
- `TELEGRAM_BOT_TOKEN=your_telegram_bot_token` (the template placeholder) fails the pattern.

## Using configuration in code

```ts
constructor(config: ConfigService<EnvironmentVariables, true>) {
  this.timeoutMs = config.get('TELEGRAM_REQUEST_TIMEOUT_MS', { infer: true }); // number
}
```

- `ConfigService` is global (`ConfigModule.forRoot({ isGlobal: true, … })`).
- Read values **once in the constructor** and keep them in `readonly` fields. That is the pattern everywhere in the codebase.
- `import type { EnvironmentVariables }` keeps the import type-only.

## Adding a variable (checklist)

1. Add the property to `EnvironmentVariables` with a default and constraints, type check closest to the property, e.g.:
   ```ts
   @Max(100)
   @Min(1)
   @IsInt()
   NEW_LIMIT: number = 10;
   ```
   Add a short comment if the range has a reason, like the existing Telegram limit comment.
2. Read it in the consumer's constructor with `config.get('NEW_LIMIT', { infer: true })`.
3. Update the tests in `src/config/env.validation.spec.ts`: add the default to the `toMatchObject` in `applies defaults and converts numeric strings`, and add invalid values to the `rejects %s=%j` table.
4. If e2e tests depend on it, pin it in `vitest.config.e2e.ts` → `test.env`.
5. Document it in `.env.example` (commented, default shown, range in the comment), in the top-level README's _Configuration_ table, and in this file.

## Test configuration

- **Unit tests** construct services directly with a stub `{ get: (key) => values[key] }` cast to `ConfigService`. No environment is read.
- **E2E tests** use the real `ConfigModule`, with fixed values from `vitest.config.e2e.ts`. Real environment variables take precedence over `.env`, so these override a developer's local `.env`:

```ts
env: {
  TELEGRAM_BOT_TOKEN: '123456789:e2e-test-token',
  MAX_RECIPIENTS_PER_REQUEST: '20',
  MAX_ATTACHMENTS_PER_REQUEST: '3',
  MAX_ATTACHMENT_SIZE_MB: '1',
  TELEGRAM_REQUEST_TIMEOUT_MS: '1000',
  TELEGRAM_MAX_RETRIES: '1',
  RATE_LIMIT_TTL_MS: '60000',
  RATE_LIMIT_MAX_REQUESTS: '5',
}
```

`ERROR_LOG_DIR` is not pinned. The e2e app doesn't install `ErrorFileLogger` as its logger, so it never writes files.

## Deployment notes

- Set the variables through the environment of the service manager, or put `.env` in the working directory.
- Choose limits for the host's memory (see _Derived limits_).
- Behind a reverse proxy, every client shares the proxy's IP for rate limiting unless Express `trust proxy` is enabled in `main.ts`. See [security.md](security.md#rate-limiting).
- `ERROR_LOG_DIR` must be writable by the service user. If it isn't, the service keeps running and reports the problem once on stderr.
