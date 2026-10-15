# Testing

Three levels of testing:

1. **Unit tests** (Vitest), next to the source as `*.spec.ts`.
2. **End-to-end tests** (Vitest + supertest), which run the full Nest app in-process with Telegram mocked.
3. **Manual testing**, with `test/fire.sh` against a running server, optionally backed by a fake Telegram (below).

```bash
npm test                 # unit tests (vitest.config.ts → **/*.spec.ts)
npm run test:e2e         # e2e tests (vitest.config.e2e.ts → **/*.e2e-spec.ts)
npm run test:cov         # unit tests with coverage (@vitest/coverage-v8)
npm run test:watch       # watch mode
npx vitest run src/telegram                      # one folder
npx vitest run -t "retries a dropped connection" # by test name
npm run lint && npm run build                    # always run before finishing a change
npx prettier --check "src/**/*.ts" "test/**/*.ts"
```

Current totals: 104 unit tests, 77 e2e tests, all passing.

## The golden rule: tests never reach the network

`test/setup.ts` runs for both suites:

```ts
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unmocked fetch call in a test'))),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
```

Every test that expects Telegram calls replaces `fetch` with its own `vi.fn<typeof fetch>()` via `vi.stubGlobal('fetch', fetchMock)`. An unmocked call fails the test instead of sending a real message.

## Unit tests

| File                                              | Covers                                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/env.validation.spec.ts`               | Defaults, numeric conversion, missing/malformed token, token not echoed, out-of-range values                                                                          |
| `src/telegram/telegram.service.spec.ts`           | Request shapes (JSON and `FormData`), message IDs, error classification, retries (backoff, `retry_after`, limits, attempt counts), timeout, token-safe network errors |
| `src/notifications/notifications.service.spec.ts` | Recipient limit, concurrency (≤ 5), ordering, failures, bad token → 500, caption mode, reply mode, photo fallback, text fallback, warnings                            |
| `src/notifications/attachment.spec.ts`            | Photo detection (PNG/JPEG yes; text named `.png`, GIF, WebP, PDF, short files no), the 10 MiB boundary, file name cleanup                                             |
| `src/logging/error-file.logger.spec.ts`           | JSONL format, Error objects, request ID, daily rotation, retention, disabled dir, unwritable dir                                                                      |
| `src/rate-limit/rate-limit-message.spec.ts`       | 429 wording: seconds, minutes, plurals, rounding, never 0                                                                                                             |

Patterns used:

- **Constructing services directly** with a config stub:
  ```ts
  const values: Partial<EnvironmentVariables> = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_REQUEST_TIMEOUT_MS: 1000,
    TELEGRAM_MAX_RETRIES: 0,
  };
  const config = { get: (key: keyof EnvironmentVariables) => values[key] };
  new TelegramService(
    config as unknown as ConfigService<EnvironmentVariables, true>,
  );
  ```
- **Mocking `TelegramService`** in service tests: typed mocks `vi.fn<TelegramService['sendMessage']>()` returning `SendResult` via the helper `sent(messageId?, failedAttempts = [])`. Attachments come from `attachment(filename, isPhoto = false)`.
- **Fake Telegram responses**: `telegramResponse(status, body)`, `delivered()` (`{ ok: true, result: { message_id: 1 } }`), `failure(code, description, parameters?)`, `rateLimited(seconds)`.
- **Reading `FormData` bodies**: `formFields(init)` returns `{ field: value }` with files as `{ filename, text }`.
- **Timers**: `vi.useFakeTimers({ toFake: ['setTimeout'] })` plus `await vi.advanceTimersByTimeAsync(ms)` for retry waits. For promises that will reject while time advances, create the `expect(...).rejects` first, advance timers, then `await` it, to avoid unhandled rejections.
- **Dates**: `vi.useFakeTimers({ toFake: ['Date'] })` plus `vi.setSystemTime(...)` (logger rotation).
- **Silencing logs**: `vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)`. The spy also lets you assert log lines.
- **Call order**: `mock.invocationCallOrder[0]` comparisons (message before files).

## End-to-end tests (`test/notifications.e2e-spec.ts`)

- A fresh app per test (`beforeEach`): `Test.createTestingModule({ imports: [AppModule] })`, then `createNestApplication()` and `app.init()`. The rate-limit counters are therefore fresh in every test.
- Configuration is pinned in `vitest.config.e2e.ts`: token `123456789:e2e-test-token`, 20 recipients, **3 attachments**, **1 MB** files, **1000 ms** timeout, **1 retry**, rate limit **5/60 s**. These override any local `.env`.
- The default `fetchMock` returns `delivered()` for every call.
- Helpers:
  - `post(body)`: JSON request.
  - `postForm()`: multipart request; chain `.field(name, value)` and `.attach('files', Buffer, filename)`.
  - `telegramCalls()`: every mocked call as `{ method, params }` (JSON parsed, or `FormData` with files as `{ filename, text }`).
  - `chatIdOf(init)`: the chat ID of a call, JSON or `FormData`.
- The `ErrorFileLogger` is _not_ installed as the logger in e2e (only `main.ts` does that), so no files are written.

Groups: delivery basics, request IDs, retries, bad token, request validation (JSON), attachments (multipart) and their validation, cross-site requests, rate limiting, startup configuration.

The startup test uses `vi.stubEnv('TELEGRAM_BOT_TOKEN', '')` and `vi.resetModules()` to import a fresh `AppModule`, and expects compilation to fail with the token message.

## Writing a new test: checklist

- Put unit tests next to the source; e2e tests in `test/notifications.e2e-spec.ts`.
- Mock `fetch` explicitly. Assert both the HTTP response and what was sent (`telegramCalls()` / `fetchMock.mock.calls`).
- For any rejection, assert `expect(fetchMock).not.toHaveBeenCalled()`. That is the "nothing is sent before validation" invariant.
- Assert full error strings (`toEqual([...])`). Messages are part of the contract.
- Use `it.each` tables for variations, following the existing style (`'rejects %s'`, `'accepts chat IDs as %s'`).
- Prove a test can fail: temporarily break the behaviour and check that it goes red. This session did so for UTF-8 file names, cross-site checks and `chat_ids` normalization.

## Manual testing with `test/fire.sh`

An interactive menu that sends real requests. Run it from `test/` (its sample files are referenced as `files/...`):

```bash
cd test && ./fire.sh
```

Settings come from the project's `.env` (the same file as the server). It reads only `PORT`, `MAX_ATTACHMENTS_PER_REQUEST`, `MAX_ATTACHMENT_SIZE_MB`, `TELEHOOK_API_URL` and `TELEHOOK_CHAT_IDS`, and never `source`s the file. A shell variable wins over `.env`, which wins over the defaults (`http://localhost:$PORT/api/send`; chats `5064323191,-5441480508`; 5 files; 10 MB). `TELEHOOK_ENV_FILE` points it at another env file. Press `s` to change the URL and chat IDs while it runs.

| Key | Sends to Telegram? | Case                                                  | Expected           |
| --- | ------------------ | ----------------------------------------------------- | ------------------ |
| 1   | yes                | Message + PNG + log (reply mode)                      | 200                |
| 2   | yes                | Message + one PNG (caption mode)                      | 200                |
| 3   | yes                | Text-only, multipart                                  | 200                |
| 4   | yes                | Text-only, JSON                                       | 200                |
| 5   | yes                | PNG + JPEG + log                                      | 200                |
| 6   | yes                | Message over 1024 chars + one file (reply mode)       | 200                |
| 7   | yes                | Command output from stdin (`files=@-;filename=…`)     | 200                |
| 8   | yes                | Server snapshot, skipping empty files (README recipe) | 200                |
| 9   | yes                | Message from a file: emoji, accents, leading `@`      | 200                |
| h   | yes                | Custom `X-Request-Id`, shows headers                  | 200                |
| a   | no                 | Empty file                                            | 400                |
| b   | no                 | `MAX_ATTACHMENTS_PER_REQUEST + 1` files               | 400                |
| c   | no                 | File of `MAX_ATTACHMENT_SIZE_MB` + 1 byte             | 413                |
| d   | no                 | Invalid chat ID                                       | 400                |
| e   | no                 | Urlencoded body                                       | 415                |
| f   | no                 | `Origin: https://evil.example`                        | 403                |
| g   | no                 | Invalid requests until rate limited                   | 429 with countdown |

Each result shows the body, plus `-> HTTP <status> in <seconds>s`. Options `b` and `c` assume the script's limits match the server's; reading the same `.env` takes care of that.

The script can be driven non-interactively by piping keys, which is how it was verified:

```bash
cd test && printf '123456789habcdef0' | TERM=dumb TELEHOOK_API_URL=http://127.0.0.1:39871/api/send bash fire.sh
```

## Verifying against a fake Telegram

To test real HTTP behaviour (curl uploads, Node's `FormData` serialization, retries after dropped connections, photo fallbacks) **without** sending real messages, run the built app with a preload module that redirects `api.telegram.org` to a local fake Bot API server. Keep this file outside the repo, e.g. in a temp directory:

```js
// fake-telegram.mjs — usage: node --import file:///abs/path/fake-telegram.mjs dist/main.js
//   FAKE_RESETS=n   cut the connection for the first n requests (→ ECONNRESET or UND_ERR_SOCKET, retried)
//   sendPhoto of a file named *tall*      → 400 PHOTO_INVALID_DIMENSIONS (→ sent as a file)
//   first sendDocument of ratelimited.txt → 429 retry_after 1
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire('file:///ABSOLUTE/PATH/TO/telehook/package.json');
const busboy = require('busboy'); // a dependency of multer
let nextId = 100,
  resets = Number(process.env.FAKE_RESETS ?? 0),
  limitedOnce = false;
const log = (line) => process.stdout.write(`[fake-telegram] ${line}\n`);
const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  if (resets > 0) {
    resets--;
    log('cutting the connection');
    return req.socket.destroy();
  }
  const method = req.url.split('/').pop();
  if (req.headers['content-type']?.startsWith('application/json')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const b = JSON.parse(raw);
      log(`${method} chat=${b.chat_id} text=${JSON.stringify(b.text)}`);
      reply(res, 200, { ok: true, result: { message_id: nextId++ } });
    });
    return;
  }
  const fields = {},
    files = [];
  const bb = busboy({ headers: req.headers, defParamCharset: 'utf8' });
  bb.on('field', (n, v) => (fields[n] = v));
  bb.on('file', (n, s, info) => {
    let size = 0;
    s.on('data', (c) => (size += c.length));
    s.on('end', () => files.push({ n, name: info.filename, size }));
  });
  bb.on('close', () => {
    const f = files[0];
    log(
      `${method} chat=${fields.chat_id} ${f.n}=${JSON.stringify(f.name)} (${f.size} B) caption=${JSON.stringify(fields.caption)} reply=${fields.reply_parameters} silent=${fields.disable_notification}`,
    );
    if (method === 'sendPhoto' && f.name.includes('tall'))
      return reply(res, 400, {
        ok: false,
        error_code: 400,
        description: 'Bad Request: PHOTO_INVALID_DIMENSIONS',
      });
    if (
      method === 'sendDocument' &&
      f.name === 'ratelimited.txt' &&
      !limitedOnce
    ) {
      limitedOnce = true;
      return reply(res, 429, {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 1',
        parameters: { retry_after: 1 },
      });
    }
    reply(res, 200, { ok: true, result: { message_id: nextId++ } });
  });
  req.pipe(bb);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
server.unref();
const base = `http://127.0.0.1:${server.address().port}`,
  realFetch = globalThis.fetch;
globalThis.fetch = (url, init) =>
  realFetch(String(url).replace('https://api.telegram.org', base), init);
```

Run it with a **fake token**, so the real one from `.env` is never used (environment variables override `.env`):

```bash
npm run build
FAKE_RESETS=1 TELEGRAM_BOT_TOKEN=123456789:fake-token PORT=39871 ERROR_LOG_DIR= \
  node --import file:///abs/path/fake-telegram.mjs dist/main.js
# in another terminal:
curl -sS -i http://127.0.0.1:39871/api/send -F chat_ids=1 -F message=hi -F files=@test/files/sample.png
```

Stop the server when done. On Windows, `Stop-Process` the PID listening on the port.

## Known test-environment notes

- **Windows + Git Bash:** `curl.exe` may mangle non-ASCII command-line arguments (file paths, emoji). Read values from files instead (`-F "message=<file"`), as `fire.sh` option 9 does.
- **Line endings:** the repo uses LF in the index, with `core.autocrlf=true` on Windows. Git may warn "LF will be replaced by CRLF"; that is harmless.
- **`free`, `ps --sort`** in snapshot recipes are Linux tools. On Git Bash their errors are captured into the snapshot file, which is fine for testing.
