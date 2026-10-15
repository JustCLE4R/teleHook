# Logging, error log and request IDs

teleHook logs to the console like any Nest app. It also keeps a **structured error log**: every warning and error is appended as one JSON object per line to a daily file, so problems such as flaky connections to Telegram can be counted and analysed later. Request IDs tie together all the lines of one API request.

Source: `src/logging/` (`error-file.logger.ts`, `request-context.ts`, `logging.module.ts`), installed in `src/main.ts`.

## Components

| Component            | Role                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ErrorFileLogger`    | Extends Nest's `ConsoleLogger`. Prints everything as usual; additionally appends `warn` and `error` entries to `ERROR_LOG_DIR/errors-YYYY-MM-DD.jsonl`. Installed as the app logger with `app.useLogger(app.get(ErrorFileLogger))`. |
| `assignRequestId`    | Express middleware (all routes): picks the request ID, sets the `X-Request-Id` response header, and runs the rest of the request inside `AsyncLocalStorage`.                                                                        |
| `currentRequestId()` | Returns the ID of the request currently being handled, or `undefined` outside a request.                                                                                                                                            |

Code logs through Nest's `Logger`:

```ts
private readonly logger = new Logger(NotificationsService.name);
this.logger.warn(`Delivery to chat ${chatId} failed: ${reason}`);
```

Static and instance `Logger` calls are routed to the installed app logger, so nothing special is needed to reach the error file.

## Error log files

- **Location:** `ERROR_LOG_DIR` (default `logs`, resolved against the working directory). The `logs` directory is git-ignored.
- **Name:** `errors-YYYY-MM-DD.jsonl`, using the **UTC** date of each entry. A new file starts at 00:00 UTC.
- **Content:** only `warn` and `error`. `log`, `debug` and `verbose` go to the console only.
- **Format:** one JSON object per line (JSON Lines), UTF-8, appended (`flags: 'a'`).
- **Creation:** lazy. The directory and file are created on the first warning or error, so idle apps and test runs create nothing.
- **Retention:** each time a day's file is opened, files matching `errors-YYYY-MM-DD.jsonl` whose day ended more than `ERROR_LOG_RETENTION_DAYS` days ago are deleted. Other files in the directory are left alone. A file is kept for the whole of its last day: with 30 days, on 2026-10-15 `errors-2026-09-15.jsonl` is kept and `errors-2026-09-14.jsonl` is deleted.
- **Disabled:** set `ERROR_LOG_DIR=` (empty) and nothing is written.
- **Failures:** if the directory can't be created or the file can't be written, the problem is printed **once** on stderr (`Could not write the error log in <dir>: <message>`) and the app carries on. Each new write tries again, so the log recovers if the directory becomes writable.
- **Shutdown:** `onApplicationShutdown()` ends the stream and resolves once the data is flushed. Shutdown hooks are enabled in `main.ts`.

### Entry schema (`ErrorLogEntry`)

```ts
interface ErrorLogEntry {
  time: string; // ISO 8601 UTC, e.g. "2026-10-14T22:56:00.161Z"
  level: 'warn' | 'error';
  context?: string; // logger context, e.g. "TelegramService", "NotificationsService", "ExceptionsHandler"
  request_id?: string; // absent outside a request (startup, shutdown)
  message: string; // for Error objects: error.message; non-strings are JSON-stringified
  stack?: string; // for errors with a stack trace
}
```

Fields whose value is `undefined` are omitted from the JSON.

How the fields are derived from a Nest logger call (`record()`):

- `context` is the **last** parameter if it is a string that does not look like a stack trace (`isStackFormat`).
- `stack` is the first parameter that looks like a stack trace or, when the message is an `Error`, its `stack`.
- Nest's `ExceptionsHandler` logs unexpected exceptions as `Error` objects, so 500s from bugs are captured with their stack.

Example, a real failed upload of an alert with ID `cpu-check-web1`:

```json
{"time":"2026-10-14T22:55:59.143Z","level":"warn","context":"TelegramService","request_id":"cpu-check-web1","message":"Request to Telegram failed: UND_ERR_SOCKET"}
{"time":"2026-10-14T22:55:59.144Z","level":"warn","context":"TelegramService","request_id":"cpu-check-web1","message":"sendPhoto failed (Could not reach Telegram (UND_ERR_SOCKET); delivery could not be confirmed); retry 1 of 3 in 1000 ms"}
…
{"time":"2026-10-14T22:56:09.193Z","level":"warn","context":"NotificationsService","request_id":"cpu-check-web1","message":"Delivery to chat 5064323191 failed: Attachment 1 (\"sample.png\"): Could not reach Telegram (UND_ERR_SOCKET); delivery could not be confirmed (after 4 attempts)"}
```

### What gets logged

| Level | Context                | Message                                                                              | When                                                        |
| ----- | ---------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| warn  | `TelegramService`      | `Request to Telegram failed: <CODE>`                                                 | Every network error (no HTTP response)                      |
| warn  | `TelegramService`      | `<method> failed (<reason>); retry <n> of <max> in <ms> ms`                          | Before every retry                                          |
| warn  | `NotificationsService` | `Telegram refused "<file>" as a photo for chat <id>; sending it as a file: <reason>` | Photo → document fallback                                   |
| warn  | `NotificationsService` | `Delivery to chat <id> failed: <error>`                                              | A chat's final failure (the same text as `results[].error`) |
| error | `NotificationsService` | `Telegram rejected the bot token; check TELEGRAM_BOT_TOKEN`                          | Bad token (500)                                             |
| error | `NotificationsService` | `Unexpected error while delivering to chat <id>` + stack                             | A bug during delivery                                       |
| error | `ExceptionsHandler`    | the exception message + stack                                                        | Any unhandled exception (500)                               |
| log   | `Bootstrap`            | `Listening on port <port>`                                                           | Startup (console only)                                      |

Successful deliveries are not logged.

### Never logged

- The bot token. Error messages are built from codes only. See [security.md](security.md#token-handling).
- Message text and file contents.

Chat IDs and (sanitized) file names **are** logged, so restrict access to `ERROR_LOG_DIR`.

### Log injection

- File names lose control characters (`\p{Cc}`) in `toAttachment()` before they can reach a log line. multer turns `%0A` in a file name into a real newline, which is why this matters.
- Incoming `X-Request-Id` values must match `^[\w.-]{1,64}$`; anything else is replaced by a UUID.
- Everything is written with `JSON.stringify`, so quotes and newlines in values are escaped.

## Request IDs

```text
incoming X-Request-Id matches ^[\w.-]{1,64}$ ?  → use it
otherwise (missing, too long, spaces, quotes…) → crypto.randomUUID()
response header X-Request-Id: <id>
AsyncLocalStorage.run({ requestId: id }, next)
```

- Applied by `LoggingModule` to all routes (`forRoutes('*')`). It runs before the cross-site and content-type checks, so even 403/415/404/429 responses carry an ID.
- Exception: bodies rejected by Express's JSON parser (malformed JSON, over 100 KB) fail before this middleware and have no ID.
- The ID survives everything asynchronous in the request: multer callbacks, `fetch`, retry `setTimeout`s and concurrent chat deliveries.
- Callers should send a meaningful ID, e.g. `X-Request-Id: cpu-check-web1-1792020658`, to find their request in the log.

## Analysing the log

With [jq](https://jqlang.org/):

```bash
# Most frequent problems, with numbers blanked so similar lines group together
jq -r '.message | gsub("[0-9]+"; "N")' logs/errors-*.jsonl | sort | uniq -c | sort -rn | head

# Network error codes per hour (ECONNRESET, ETIMEDOUT, …)
jq -r 'select(.message | startswith("Request to Telegram failed")) | .time[0:13] + " " + .message' logs/errors-*.jsonl | sort | uniq -c

# Everything about one request
jq 'select(.request_id == "cpu-check-web1")' logs/errors-*.jsonl

# Final delivery failures only
jq -r 'select(.message | startswith("Delivery to chat")) | .time + " " + .message' logs/errors-*.jsonl

# Requests that needed retries but succeeded: retry lines whose request has no final failure
jq -r 'select(.message | test("retry [0-9]+ of")) | .request_id' logs/errors-*.jsonl | sort -u > retried.txt
jq -r 'select(.message | startswith("Delivery to chat")) | .request_id' logs/errors-*.jsonl | sort -u > failed.txt
comm -23 retried.txt failed.txt
```

Patterns to look for when improving the service:

| Pattern                                                          | Likely cause                                                                     | Mitigation                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Many `Request to Telegram failed: ECONNRESET` / `UND_ERR_SOCKET` | Unstable route to `api.telegram.org`, stale keep-alive sockets, ISP interference | Retries cover short bursts; consider more retries, a different network path, or a proxy |
| `ETIMEDOUT` / `did not respond within`                           | Slow or blocked link, large uploads                                              | Raise `TELEGRAM_REQUEST_TIMEOUT_MS`, send smaller files                                 |
| `Rate limited by Telegram`                                       | Bursts to one group (20 msgs/min)                                                | Fewer files per alert, merge alerts                                                     |
| `Telegram refused "…" as a photo`                                | Very tall or odd images                                                          | Harmless (sent as files); crop screenshots if inline display matters                    |
| `Telegram API error 403: Forbidden: …`                           | Bot blocked or removed from a chat                                               | Fix the chat list                                                                       |
| `(the group is now chat ID …)`                                   | Group upgraded to a supergroup                                                   | Update the chat ID                                                                      |

## Tests

- `src/logging/error-file.logger.spec.ts`: JSON lines, Error objects, request IDs, daily rotation (fake `Date`), retention, disabled directory, unwritable directory (reported once).
- `test/notifications.e2e-spec.ts` → `describe('request IDs')`: generated IDs, kept caller IDs, replaced invalid IDs, and the ID reaching warnings logged during retries.
