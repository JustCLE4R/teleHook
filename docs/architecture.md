# Architecture

How teleHook is put together: modules, the path of a request through the app, and where each concern lives. For the HTTP contract see [api-reference.md](api-reference.md); for delivery logic see [delivery.md](delivery.md).

## Module graph

```text
AppModule (src/app.module.ts)
├── ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })   config/env.validation.ts
├── RateLimitModule                                                   rate-limit/
│   ├── ThrottlerModule.forRootAsync(...)      reads RATE_LIMIT_TTL_MS, RATE_LIMIT_MAX_REQUESTS
│   └── provider APP_GUARD → ThrottlerGuard    (global, applies to every route)
├── LoggingModule                                                     logging/
│   ├── provider ErrorFileLogger (exported; installed as the app logger in main.ts)
│   └── middleware assignRequestId → forRoutes('*')
├── NotificationsModule                                               notifications/
│   ├── imports TelegramModule → provides/exports TelegramService     telegram/
│   ├── controller NotificationsController  (POST /api/send)
│   ├── provider NotificationsService
│   └── middleware rejectCrossSiteRequests, requireSupportedBody → forRoutes(NotificationsController)
└── provider APP_PIPE → ValidationPipe({ whitelist, forbidNonWhitelisted, transform, stopAtFirstError })
```

- `ConfigService` is global, so every provider can inject it. Providers read typed values with `config.get('NAME', { infer: true })` using `ConfigService<EnvironmentVariables, true>`.
- `MultipartFormInterceptor` is not listed as a provider. Nest instantiates it from `@UseInterceptors(MultipartFormInterceptor)` on the controller method, injecting `ConfigService`.
- `APP_GUARD` and `APP_PIPE` are global no matter which module declares them.

## Bootstrap (`src/main.ts`)

1. `NestFactory.create(AppModule, { bufferLogs: true })`. Log lines during startup are held in a buffer.
2. `app.useLogger(app.get(ErrorFileLogger))`. The buffered lines are flushed into it, so startup warnings and errors also reach the error log.
3. `app.disable('x-powered-by')`, `app.enableShutdownHooks()`. On SIGTERM/SIGINT, `ErrorFileLogger.onApplicationShutdown()` flushes the log file.
4. Reads `PORT`, calls `app.listen(port)` (all interfaces), and logs `Listening on port N` with context `Bootstrap`.

If environment validation fails, `ConfigModule` throws during module creation and the process exits with code 1. See [configuration.md](configuration.md#startup-validation).

`main.ts` uses top-level `await bootstrap()`, which works because the package is ESM.

## Request pipeline

Every request to `POST /api/send` goes through these stages, in this order. A stage that throws ends the request with its error. Later stages never run, and no Telegram call is made.

| #   | Stage                          | Where                                            | What it does                                                                                                                                                | Can respond                                        |
| --- | ------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Express body parsers           | Nest default (`json`, `urlencoded`)              | Parses `application/json` (limit **100 KB**) and urlencoded bodies into `req.body`. Multipart is _not_ parsed here.                                         | 400 malformed JSON, 413 `request entity too large` |
| 2   | `assignRequestId`              | `logging/request-context.ts`                     | Keeps a valid incoming `X-Request-Id` or generates a UUID; sets the `X-Request-Id` response header; runs the rest of the request inside `AsyncLocalStorage` | —                                                  |
| 3   | `rejectCrossSiteRequests`      | `notifications/notifications.module.ts`          | Rejects browser requests from other sites using `Sec-Fetch-Site` / `Origin`                                                                                 | 403                                                |
| 4   | `requireSupportedBody`         | `notifications/notifications.module.ts`          | Allows only `application/json` and `multipart/form-data` (or no body at all)                                                                                | 415                                                |
| 5   | `ThrottlerGuard`               | `rate-limit/rate-limit.module.ts` (global guard) | Counts the request against the client IP's window; blocks over the limit; sets `X-RateLimit-*` and `Retry-After` headers                                    | 429                                                |
| 6   | `MultipartFormInterceptor`     | `notifications/multipart-form.interceptor.ts`    | For multipart only: parses with multer (memory), enforces upload limits, rejects empty files and text-valued `files`, normalizes `chat_ids`                 | 400, 413                                           |
| 7   | `ValidationPipe`               | global `APP_PIPE`                                | Transforms `req.body` into `SendNotificationDto` and validates it; rejects unknown properties                                                               | 400                                                |
| 8   | `NotificationsController.send` | `notifications/notifications.controller.ts`      | Converts uploads to `Attachment`s (`toAttachment`), calls the service, sets 200 or 207                                                                      | 200, 207                                           |
| 9   | `NotificationsService.send`    | `notifications/notifications.service.ts`         | Enforces `MAX_RECIPIENTS_PER_REQUEST`, then delivers to each chat (≤ 5 at a time)                                                                           | 400, 500                                           |
| 10  | `TelegramService`              | `telegram/telegram.service.ts`                   | Calls the Bot API with timeout and retries; maps failures to `TelegramApiError`                                                                             | —                                                  |

Consequences of this order, all verified against the running app:

- **Request IDs are on almost every response**, including 403, 415, 404 and 429. The exceptions are **malformed JSON (400) and oversized JSON (413)**: stage 1 rejects those before stage 2 assigns an ID.
- **403 and 415 rejections do not count toward the rate limit**, because they happen before the guard. 400s from the interceptor, pipe or service _do_ count, because they happen after it. `fire.sh` option `g` relies on this to trigger 429 without sending messages.
- **Rate-limited clients never upload files into memory.** The guard (5) runs before multer (6).
- **Multipart bodies are fully buffered before DTO validation.** A request with invalid `chat_ids` and a 10 MB file reads the whole file first, then gets 400.
- **The recipient limit is checked in the service (9), not the DTO**, because it depends on configuration. Its error has the same body shape as validation errors.

## Data flow

```text
HTTP request
  │  JSON: req.body = { chat_ids: string[], message: string }
  │  multipart: multer → req.body (text fields) + req.files (Express.Multer.File[])
  │             normalizeChatIds: "1,2" | ["1","2"] | ["1, 2"] → ["1","2"]
  ▼
SendNotificationDto { chat_ids: string[]; message: string }      (validated)
Express.Multer.File[] ──toAttachment()──► Attachment[] { filename, content: Blob, isPhoto }
  ▼
NotificationsService.send(chatIds, message, attachments)
  │  for each chat (≤ 5 concurrently): deliver() → DeliveryResult (+ warnings)
  ▼
DeliverySummary { total, sent, failed, results: DeliveryResult[] }
  ▼
SendNotificationResponse { success, message, data: DeliverySummary }   → 200 or 207
```

The file bytes are copied into a `Blob` **once per attachment** in the controller, and that `Blob` is reused for every chat and every retry. Telegram still receives a separate upload per chat; Bot API `file_id` reuse is not implemented.

## Where each concern lives

| Concern                                                    | Location                                            |
| ---------------------------------------------------------- | --------------------------------------------------- |
| Environment schema, defaults, ranges                       | `config/env.validation.ts` (`EnvironmentVariables`) |
| JSON field rules and messages                              | `notifications/dto/send-notification.dto.ts`        |
| Multipart parsing, upload limits, upload error messages    | `notifications/multipart-form.interceptor.ts`       |
| Photo vs document decision, file name cleanup              | `notifications/attachment.ts`                       |
| Delivery order, caption vs reply mode, fallbacks, warnings | `notifications/notifications.service.ts`            |
| Bot API calls, retries, error classification               | `telegram/telegram.service.ts`                      |
| 200 vs 207, response envelope                              | `notifications/notifications.controller.ts`         |
| Cross-site protection, allowed content types               | `notifications/notifications.module.ts`             |
| Rate limit and 429 wording                                 | `rate-limit/`                                       |
| Request IDs, error log files                               | `logging/`                                          |

## Concurrency model

- **Across chats:** `mapWithConcurrency` (in `notifications.service.ts`) runs at most `MAX_CONCURRENT_DELIVERIES = 5` chat deliveries at once and keeps results in input order.
- **Within a chat:** strictly sequential. Message, then attachments in upload order, each awaited before the next.
- **Abort rule:** if a chat's delivery _throws_ (only the bot-token 500 does), no further chats start and the error propagates. Deliveries already in flight finish, but their results are discarded. Some chats may already have received the message when a 500 is returned.
- **Across requests:** independent. There is no shared state except the throttler's in-memory counters and the error-log file stream.

## Async context

`assignRequestId` calls `storage.run({ requestId }, next)`, so everything that runs for the request, including multer callbacks (multer uses `AsyncResource`), timers from retry sleeps and `fetch` continuations, sees the same store. `ErrorFileLogger` reads it with `currentRequestId()`. An e2e test (`tags the logs written while handling the request`) proves the ID reaches warnings logged during retries inside a multipart request.

## Response envelope

```ts
interface SendNotificationResponse {
  success: boolean; // summary.failed === 0
  message:
    | 'Notification processing completed'
    | 'Notification processing completed with failures';
  data: DeliverySummary;
}
interface DeliverySummary {
  total: number;
  sent: number;
  failed: number;
  results: DeliveryResult[];
}
interface DeliveryResult {
  chat_id: string;
  success: boolean;
  error?: string;
  warnings?: string[];
}
```

Errors that end the request (4xx/5xx) use Nest's exception body instead: `{ statusCode, message, error }`, where `message` is an array for validation-style 400s and a string otherwise. See [api-reference.md](api-reference.md#error-responses).
