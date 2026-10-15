# teleHook documentation index

> **Start here.** This folder is the detailed reference for teleHook, written so that an AI coding agent (or a new developer) can work on the project without reading every source file first. Each document is self-contained, cites the source file and symbol it describes, and states facts precisely: exact error strings, limits, defaults and the order things happen in.
>
> The top-level [`../README.md`](../README.md) is the user-facing guide. This folder goes deeper and explains _why_.

## What teleHook is

A small, stateless NestJS 12 REST service with one endpoint, `POST /api/send`. Each request names Telegram chat IDs and a message, optionally with files (screenshots, graphs, logs, diagnostic reports), and the service delivers them through the Telegram Bot API, reporting the outcome per chat.

It is built as an **alert delivery channel** for server health checks: a script on a server detects a problem, collects diagnostics, and posts them here. That purpose drives most design choices: deliver the alert text first, retry flaky connections, prefer a duplicate over a lost alert, and report everything that went wrong.

| Fact          | Value                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| Runtime       | Node.js 20.19+, 22.12+ or 24+ (ESM, built-in `fetch`, `FormData`, `Blob`) |
| Framework     | NestJS 12 on Express 5 (`@nestjs/platform-express`)                       |
| Language      | TypeScript 6, `module: nodenext`, strict mode, ES2023 target              |
| Package type  | ESM (`"type": "module"`); relative imports end in `.js`                   |
| Uploads       | multer 2.4 (memory storage), declared as a direct dependency              |
| Validation    | class-validator + class-transformer, global `ValidationPipe`              |
| Rate limiting | `@nestjs/throttler` 6, in-memory, per client IP                           |
| Tests         | Vitest 4 (unit + e2e with supertest); `fetch` is blocked in tests         |
| Lint / format | oxlint (type-aware), Prettier (single quotes, trailing commas)            |
| State         | None. No database, no queue, no authentication                            |
| Endpoints     | `POST /api/send` only                                                     |

## Documents

| Document                                 | Read it when you need to…                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)       | understand the modules, the request pipeline (middleware → guard → interceptor → pipe → controller → service → Telegram) and where each concern lives      |
| [api-reference.md](api-reference.md)     | know the exact HTTP contract: fields, validation rules, response shapes, status codes, headers                                                             |
| [delivery.md](delivery.md)               | change or reason about _how_ messages and files reach each chat: caption mode, reply threading, photo detection, fallbacks, retries, warnings, concurrency |
| [telegram-client.md](telegram-client.md) | work on `TelegramService`: Bot API calls, error classification, retry policy, timeouts                                                                     |
| [configuration.md](configuration.md)     | add or change an environment variable, or look up a default, range or validation message                                                                   |
| [logging.md](logging.md)                 | work with the error log files, request IDs, or log message formats                                                                                         |
| [security.md](security.md)               | understand the threat model and the safeguards (cross-site check, token handling, limits)                                                                  |
| [testing.md](testing.md)                 | run, write or debug tests; use the manual tester `test/fire.sh`; verify against a fake Telegram                                                            |
| [development.md](development.md)         | follow the code conventions, add a feature end to end, avoid known pitfalls                                                                                |
| [error-catalog.md](error-catalog.md)     | find where an exact error, warning or log string comes from                                                                                                |
| [decisions.md](decisions.md)             | learn why things are the way they are, and which alternatives were rejected                                                                                |

## Source file map

| Path                                              | Role                                                                                                                                          | Main symbols                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/main.ts`                                     | Bootstrap: creates the app with buffered logs, installs `ErrorFileLogger`, disables `x-powered-by`, enables shutdown hooks, listens on `PORT` | `bootstrap()`                                                                          |
| `src/app.module.ts`                               | Root module: `ConfigModule` (global, validated), feature modules, global `ValidationPipe`                                                     | `AppModule`                                                                            |
| `src/config/env.validation.ts`                    | Environment schema and startup validation                                                                                                     | `EnvironmentVariables`, `validateEnv()`                                                |
| `src/rate-limit/rate-limit.module.ts`             | Throttler setup and the global `ThrottlerGuard`                                                                                               | `RateLimitModule`                                                                      |
| `src/rate-limit/rate-limit-message.ts`            | 429 message with the wait in words                                                                                                            | `rateLimitMessage()`                                                                   |
| `src/logging/logging.module.ts`                   | Provides `ErrorFileLogger`; applies `assignRequestId` to all routes                                                                           | `LoggingModule`                                                                        |
| `src/logging/request-context.ts`                  | Request IDs via `AsyncLocalStorage`; `X-Request-Id` header                                                                                    | `assignRequestId()`, `currentRequestId()`                                              |
| `src/logging/error-file.logger.ts`                | Console logger that also appends warn/error to daily JSONL files                                                                              | `ErrorFileLogger`, `ErrorLogEntry`                                                     |
| `src/telegram/telegram.module.ts`                 | Provides and exports `TelegramService`                                                                                                        | `TelegramModule`                                                                       |
| `src/telegram/telegram.service.ts`                | Bot API client: `sendMessage`, `sendPhoto`, `sendDocument`; error mapping; retries                                                            | `TelegramService`, `TelegramApiError`, `SendResult`, `TelegramFile`, `SendFileOptions` |
| `src/notifications/notifications.module.ts`       | Wires controller and service; route middleware for cross-site and content-type checks                                                         | `NotificationsModule`, `rejectCrossSiteRequests()`, `requireSupportedBody()`           |
| `src/notifications/notifications.controller.ts`   | `POST /api/send`; maps uploads to attachments; sets 200/207                                                                                   | `NotificationsController`, `SendNotificationResponse`                                  |
| `src/notifications/notifications.service.ts`      | Delivery orchestration: recipient limit, concurrency, per-chat flow, warnings, failures                                                       | `NotificationsService`, `DeliveryResult`, `DeliverySummary`                            |
| `src/notifications/multipart-form.interceptor.ts` | multer parsing, upload limits, error mapping, `chat_ids` normalization                                                                        | `MultipartFormInterceptor`, `FILES_FIELD`                                              |
| `src/notifications/attachment.ts`                 | Upload → `Attachment`: photo detection by magic bytes, file name cleanup                                                                      | `Attachment`, `toAttachment()`                                                         |
| `src/notifications/dto/send-notification.dto.ts`  | Request body validation rules and messages                                                                                                    | `SendNotificationDto`, `TELEGRAM_MAX_MESSAGE_LENGTH`                                   |
| `test/setup.ts`                                   | Shared test setup: blocks unmocked `fetch`, restores mocks                                                                                    | —                                                                                      |
| `test/notifications.e2e-spec.ts`                  | End-to-end tests of the full app (mocked Telegram)                                                                                            | —                                                                                      |
| `test/fire.sh`                                    | Interactive manual tester against a running server                                                                                            | —                                                                                      |
| `test/files/`                                     | Sample files for `fire.sh`: `sample.png`, `sample.jpg`, `test.log`                                                                            | —                                                                                      |
| `vitest.config.ts`, `vitest.config.e2e.ts`        | Test configs; the e2e one pins environment values                                                                                             | —                                                                                      |
| `.env.example`                                    | Documented template for `.env` (the real `.env` is git-ignored)                                                                               | —                                                                                      |
| `assets/`                                         | Logo files (`favicon.svg` is used by the top-level README)                                                                                    | —                                                                                      |

Unit tests sit next to their source as `*.spec.ts`.

## Rules an agent must not break

These invariants are relied on by callers, tests or security. Change one only deliberately, and update the docs and tests with it.

1. **The bot token never leaves the process.** Not in responses, not in logs, not in error messages. Network error text from `fetch` can contain the request URL, which contains the token, so only the error _code_ (e.g. `ECONNRESET`) is ever used. See [security.md](security.md#token-handling).
2. **Nothing is sent before the whole request is validated.** Any 4xx means no Telegram call was made. See [api-reference.md](api-reference.md#validation-order).
3. **The JSON contract is strict and stable.** `chat_ids` must be an array of strings in JSON; unknown properties are rejected; duplicates are rejected, not removed. Only the multipart path normalizes `chat_ids`.
4. **`data.results` matches the request one-to-one, in request order.**
5. **The alert text must get through.** In every delivery mode, a file problem never prevents the message from being attempted. See [delivery.md](delivery.md).
6. **Refusals are never retried; delivery-unknown failures are retried** (up to `TELEGRAM_MAX_RETRIES`). A duplicate alert is acceptable; a lost one is not. See [decisions.md](decisions.md#d6-retry-transient-failures-accept-duplicates).
7. **A bad bot token is a server error, not a per-chat error.** It aborts the request with 500.
8. **Browsers on other sites cannot use the API** (403), and only JSON and multipart bodies are accepted (415).
9. **Tests never reach the network.** `test/setup.ts` makes unmocked `fetch` reject.
10. **Client-supplied strings that reach logs are sanitized or validated** (file names lose control characters; request IDs must match `^[\w.-]{1,64}$`).

## Quick commands

```bash
npm install
cp .env.example .env          # then set TELEGRAM_BOT_TOKEN
npm run dev                   # watch mode
npm run build && npm run prod # production
npm test                      # unit tests
npm run test:e2e              # end-to-end tests
npm run lint                  # oxlint, type-aware
npx prettier --check "src/**/*.ts" "test/**/*.ts"
cd test && ./fire.sh          # interactive manual tester (sends real messages for options 1-9, h)
```

## Glossary

| Term                  | Meaning                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Alert / message**   | The `message` text of a request. Always delivered (or attempted) to every chat.                                                                                |
| **Attachment / file** | An uploaded file from the multipart `files` field. Internally an `Attachment` (`filename`, `content: Blob`, `isPhoto`).                                        |
| **Photo**             | A JPEG or PNG ≤ 10 MiB, sent with `sendPhoto` (shown inline, compressed by Telegram).                                                                          |
| **Document**          | Any other file, sent with `sendDocument` (unchanged, shown with its name).                                                                                     |
| **Caption mode**      | Exactly one attachment and a message ≤ 1024 UTF-16 units: one post, the file with the message as its caption.                                                  |
| **Reply mode**        | Several attachments, or a message too long for a caption: the message first, then each file as a silent reply.                                                 |
| **Refusal**           | A `TelegramApiError` with reason `rejected`: Telegram processed and declined the request, so nothing was sent. Safe to retry differently, never retried as-is. |
| **Delivery unknown**  | Timeout, network error, 5xx or unreadable response: the request may or may not have been delivered.                                                            |
| **Item**              | The thing a warning or error refers to: `Message` or `Attachment N ("name")`.                                                                                  |
| **Warning**           | A problem that did not stop delivery on its own (retried attempt, photo sent as file, text fallback), reported in `results[].warnings`.                        |
| **Request ID**        | Per-request identifier in `X-Request-Id` and in every error-log line of that request.                                                                          |
