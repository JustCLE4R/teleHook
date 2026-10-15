# Development guide

Conventions, recipes for common changes, and known pitfalls. Follow the existing style: the codebase is small and consistent, and changes should read as if the same person wrote them.

## Setup

```bash
npm install
cp .env.example .env     # set TELEGRAM_BOT_TOKEN (PowerShell: Copy-Item .env.example .env)
npm run dev              # nest start --watch
```

| Script                                            | Command                                         | Purpose                              |
| ------------------------------------------------- | ----------------------------------------------- | ------------------------------------ |
| `build`                                           | `nest build`                                    | Compile to `dist/` (cleans it first) |
| `start`                                           | `nest start`                                    | Run once                             |
| `dev`                                             | `nest start --watch`                            | Development with restarts            |
| `debug`                                           | `nest start --debug --watch`                    | With the inspector                   |
| `prod`                                            | `node dist/main`                                | Run the build                        |
| `lint`                                            | `oxlint --type-aware src/ test/`                | Lint, type-aware                     |
| `format`                                          | `prettier --write "src/**/*.ts" "test/**/*.ts"` | Format                               |
| `test` / `test:watch` / `test:cov` / `test:debug` | `vitest …`                                      | Unit tests                           |
| `test:e2e`                                        | `vitest run --config ./vitest.config.e2e.ts`    | End-to-end tests                     |

**Definition of done for any change:** `npm run lint` (zero warnings), `npm run build`, `npm test`, `npm run test:e2e`, `npx prettier --check "src/**/*.ts" "test/**/*.ts"`, and the docs in `docs/` plus the top-level README updated wherever behaviour, messages or configuration changed.

## Code conventions

### Modules and imports

- **ESM with `nodenext`:** relative imports end in `.js` even in TypeScript (`import { AppModule } from './app.module.js'`).
- **Type-only imports use `import type`.** This is required for types in decorated signatures because of `isolatedModules` + `emitDecoratorMetadata`: e.g. `import type { Response } from 'express'` in the controller. Mixed imports use inline `type`: `import { type CallHandler, Injectable } from '@nestjs/common'`.
- Import order: Node built-ins (`node:fs`), packages, then local files. Prettier doesn't sort imports, so follow the existing files.
- One folder per concern (`config/`, `rate-limit/`, `logging/`, `telegram/`, `notifications/`). There is no `common/` folder: helpers live with the feature that uses them.

### Style

- Prettier: single quotes, trailing commas, default 80-column width. Comments are wrapped by hand at about 80 columns.
- oxlint with `typescript/no-floating-promises: error`. The type-aware run also warns on unsafe optional chaining and base-to-string conversions. **Keep the lint output empty.**
- `strict` TypeScript. `any` is allowed by lint but not used; prefer `unknown` plus narrowing.
- Constants: `UPPER_SNAKE_CASE` at the top of the file, each with a `/** … */` explaining the value (e.g. `/** Telegram's limit for a caption, in UTF-16 code units like the message. */`).
- Module-private helpers are plain functions at the bottom of the file, after the class.
- Configuration is read **once in the constructor** into `private readonly` fields.

### Comments

- Explain **why**, not what. Comments state constraints, external facts (Telegram limits), security reasons and non-obvious consequences. Examples from the code:
  - `// Only the error code is used: fetch error messages can contain the request URL, and the URL contains the bot token.`
  - `// A refusal means nothing was sent, so the image can safely go out as a file instead, …`
- Exported symbols and important methods get a short JSDoc sentence.
- Full sentences, plain words, no TODO clutter.

### Error messages

- **Validation-style 400s** (DTO, recipient limit, multipart checks) are lowercase sentences naming the field, and the exception gets an **array**: `new BadRequestException(['files must contain at most 5 files'])`. This matches the `ValidationPipe` body shape.
- Name the offending value when helpful: `each file must not be empty ("errors.log" is empty)`.
- Other HTTP exceptions take a **string** message: `new ForbiddenException('Cross-site requests from web browsers are not allowed')`.
- Per-chat `error`s and `TelegramApiError` messages are capitalized sentences that say what happened and whether delivery is confirmed: `Telegram did not respond within 10000 ms; delivery could not be confirmed`.
- Never include secrets, message text, file contents, or raw `fetch` error messages.
- Messages are part of the API contract: tests assert them exactly. If you change one, update [error-catalog.md](error-catalog.md), the README and the tests.

### DTO validation

class-validator runs a property's decorators **bottom-up**, and the global pipe stops at the first failure per property, so **type checks go closest to the property**:

```ts
@MaxUtf16Length(TELEGRAM_MAX_MESSAGE_LENGTH)   // runs last
@Matches(/\S/, { message: 'message must not be empty or whitespace only' })
@IsString({ message: 'message must be a string' })   // runs first
message!: string;
```

The same ordering applies to `EnvironmentVariables`.

## Recipes

### Add a request field

1. Add the property and validators to `SendNotificationDto`, following the ordering rule. Unknown fields are rejected, so the field won't be accepted until it's declared.
2. Multipart sends every value as a string (repeated fields become arrays). If the field isn't a plain string, normalize it in `MultipartFormInterceptor` like `normalizeChatIds`, for multipart **only**. Keep JSON strict.
3. Pass it through `NotificationsController.send` → `NotificationsService.send`.
4. Tests: e2e validation cases for both JSON and multipart; service unit tests.
5. Docs: [api-reference.md](api-reference.md), README _API_, [error-catalog.md](error-catalog.md).

### Add an environment variable

See [configuration.md → Adding a variable](configuration.md#adding-a-variable-checklist).

### Add a Bot API method

See [telegram-client.md → Extending the client](telegram-client.md#extending-the-client). Return `SendResult`, throw `TelegramApiError`, and decide its retry behaviour explicitly.

### Change delivery behaviour

See [delivery.md → Changing delivery behaviour safely](delivery.md#changing-delivery-behaviour-safely). Add a warning for every problem that is worked around.

### Add a route

- Put it in a controller. If it changes state, apply `rejectCrossSiteRequests` (and a content-type check) to it, as `NotificationsModule.configure` does.
- The rate limit (global guard) and request IDs (`forRoutes('*')`) apply automatically.
- Add e2e tests for: success, validation, `Origin: https://evil.example` → 403, and that nothing is sent on rejection.

### Change a limit or default

Change the default on `EnvironmentVariables`, then update `.env.example`, the README table, [configuration.md](configuration.md), and the env validation test's defaults object. If the e2e suite depends on it, check `vitest.config.e2e.ts`.

## Pitfalls (learned the hard way)

| Pitfall                                        | Details                                                                                                          | Fix used                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Buffer` → `Blob` type error                   | TS 5.7+ types `Buffer` as `Uint8Array<ArrayBufferLike>` (possibly `SharedArrayBuffer`), which `BlobPart` rejects | `new Blob([data as Uint8Array<ArrayBuffer>])`: multer's memory storage never uses shared memory |
| `Express.Multer.File` not found                | `tsconfig.json` restricts global typings with `types`                                                            | `"types": ["vitest/globals", "node", "multer"]`                                                 |
| `MulterError.filename` missing from types      | `@types/multer` omits it, but multer 2.x sets it                                                                 | `const { filename } = error as { filename?: string }`                                           |
| multer `req.body` has no prototype             | `Object.create(null)`; `body.hasOwnProperty` doesn't exist                                                       | `Object.hasOwn(req.body, 'files')`                                                              |
| One `chat_ids` field is a string, not an array | append-field only builds arrays for repeated or bracketed fields                                                 | `normalizeChatIds` (multipart only)                                                             |
| Sparse arrays from `chat_ids[999999]`          | Huge `length`, expensive to iterate                                                                              | `fieldArrayIndexLimit: 200` and `Array.from` in normalization                                   |
| Non-ASCII file names garbled                   | busboy decodes header params as latin1 by default                                                                | `defParamCharset: 'utf8'`                                                                       |
| Wrong count for "too many files"               | `.array('files', maxCount)` reports _Unexpected field_; `limits.files` reports _Too many files_                  | Use `limits.files` with no `maxCount`                                                           |
| Request ID missing on malformed JSON           | Express's body parser runs before route middleware                                                               | Documented, not fixed                                                                           |
| Token leak through errors                      | undici error messages can contain the URL                                                                        | Only `cause.code` is used (`errorCode()`)                                                       |
| Fake timers and rejections                     | A promise that rejects while timers advance causes an unhandled rejection                                        | Create `expect(promise).rejects…` first, advance timers, then `await` it                        |
| Nest middleware wildcard                       | Nest 12 accepts `forRoutes('*')` without the legacy-wildcard warning                                             | Kept as is                                                                                      |
| Shell-generated files                          | In Git Bash, heredocs and `node -e` strings containing backticks or `$` can be expanded by the shell             | Write files with an editor or a quoted heredoc; check the result                                |
| Windows `curl.exe` and non-ASCII arguments     | Arguments may be re-encoded                                                                                      | Read values from files (`-F "message=<file"`)                                                   |
| Stray dev servers                              | Background `node dist/main.js` keeps the port                                                                    | Find the PID listening on the port and stop it                                                  |
| Line endings                                   | `core.autocrlf=true`; sources are LF in the index                                                                | Ignore "LF will be replaced by CRLF" warnings                                                   |

## Dependencies

| Package                                            | Why                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@nestjs/*` 12                                     | Framework, Express platform, config, testing                                                             |
| `@nestjs/throttler`                                | Rate limiting                                                                                            |
| `class-validator`, `class-transformer`             | DTO and environment validation                                                                           |
| `multer` 2.4                                       | Multipart parsing (also bundled by `@nestjs/platform-express`, declared directly because it is imported) |
| `@types/multer` (dev)                              | Types for multer and `Express.Multer.File`                                                               |
| `reflect-metadata`                                 | Decorator metadata; imported explicitly in `env.validation.ts`                                           |
| `rxjs`                                             | Nest interceptors                                                                                        |
| `vitest`, `supertest`, `@vitest/coverage-v8` (dev) | Tests                                                                                                    |
| `oxlint`, `oxlint-tsgolint`, `prettier` (dev)      | Lint and format                                                                                          |

No HTTP client library: the built-in `fetch`, `FormData` and `Blob` are used.

## Git

- `main` is the PR base branch; work happens on `master` in this clone.
- Commit messages follow Conventional Commits, as in the history: `feat: …`, `feat(logging): …`.
- Never commit `.env`, `logs/` or `dist/` (all git-ignored). Sample files under `test/files/` are tracked; `!test/*/*.log` re-includes `test/files/test.log` despite the `*.log` rule.

## Ideas not implemented (for future work)

These were discussed and deliberately left out. Each would be a self-contained change:

- **Authentication** (API key or bearer token) for deployments without a proxy.
- **Durable outbox:** persist requests and retry for hours, so alerts survive Telegram outages and restarts (the API would answer 202).
- **`file_id` reuse:** upload a file once and send it to other chats by `file_id`, saving bandwidth for multi-chat requests.
- **Configurable Bot API base URL**, for a local `telegram-bot-api` server (uploads up to 2000 MB).
- **Media groups (albums)** for several photos.
- **JSON attachments** (base64 or URLs) for clients that cannot send multipart.
