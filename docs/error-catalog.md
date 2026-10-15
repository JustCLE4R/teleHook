# Error, warning and log catalog

Every user-visible or logged string, grouped by where it comes from. Use it to trace a message back to its code, or to find which tests assert it. `<…>` marks values filled in at runtime.

Search tip: most strings are unique, so `grep -rn "<fixed part>" src` finds the origin.

## 1. Startup (process exits with code 1)

Thrown by `validateEnv()` (`src/config/env.validation.ts`) as:

```text
Invalid environment configuration:
  - <message>
  - <message>
```

| Message                                                                                            | Cause                                                                   |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN must be set to the bot token issued by @BotFather (format: <bot id>:<secret>)` | Missing or not matching `^\d+:[\w-]+$` (the value is never printed)     |
| `<NAME> must be an integer number`                                                                 | Non-integer, e.g. `2.5`, `twenty`                                       |
| `<NAME> must not be less than <n>`                                                                 | Below minimum (also for an empty numeric value, which converts to 0)    |
| `<NAME> must not be greater than <n>`                                                              | Above maximum                                                           |
| `<NAME> must be a string`                                                                          | `ERROR_LOG_DIR` of a non-string type (not reachable from real env vars) |

## 2. Request rejected (no Telegram call made)

### 400 Bad Request, `message` is an array

DTO validation (`src/notifications/dto/send-notification.dto.ts`), first failure per field:

| Message                                                                                   | Field rule                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `chat_ids must be an array of chat ID strings`                                            | `chat_ids` missing or not an array (JSON)                                |
| `chat_ids must contain at least one chat ID`                                              | Empty array                                                              |
| `each chat ID must be a string`                                                           | An entry is not a string (a number in JSON, or a gap from `chat_ids[5]`) |
| `each chat ID must be a numeric Telegram chat ID such as "123456789" or "-1001234567890"` | An entry fails `^-?[1-9]\d{0,15}$` (includes `""` from `1,`)             |
| `chat_ids must not contain duplicates`                                                    | Duplicate entries                                                        |
| `message must be a string`                                                                | Missing, non-string, or a repeated multipart field                       |
| `message must not be empty or whitespace only`                                            | No non-whitespace character                                              |
| `message must be at most 4096 characters long`                                            | More than 4096 UTF-16 code units                                         |
| `property <name> should not exist`                                                        | Unknown property (`forbidNonWhitelisted`)                                |

Service (`NotificationsService.send`):

| Message                                      | Cause                                  |
| -------------------------------------------- | -------------------------------------- |
| `chat_ids must contain at most <N> chat IDs` | More than `MAX_RECIPIENTS_PER_REQUEST` |

Multipart (`src/notifications/multipart-form.interceptor.ts`):

| Message                                                              | Cause                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `files must contain at most <N> files`                               | More than `MAX_ATTACHMENTS_PER_REQUEST` file parts (multer `LIMIT_FILE_COUNT`)                            |
| `unexpected file in field "<field>"; only "files" may contain files` | A file part named anything but `files` (`LIMIT_UNEXPECTED_FILE`)                                          |
| `files must be file uploads, not text fields`                        | A text field named `files` (e.g. `-F files=path` without `@`)                                             |
| `each file must not be empty ("<name>" is empty)`                    | A zero-byte file                                                                                          |
| `malformed multipart body: <busboy message>`                         | Broken multipart, e.g. `Unexpected end of form`, `Multipart: Boundary not found`, `Malformed part header` |
| `Too many fields`                                                    | More than 200 text fields (`LIMIT_FIELD_COUNT`)                                                           |
| `Field value too long: <field>`                                      | A text field over 64 KiB (`LIMIT_FIELD_VALUE`)                                                            |
| `Field name too long`                                                | A field name over 100 bytes (`LIMIT_FIELD_KEY`)                                                           |
| `Field name nesting too deep: <field>`                               | e.g. `a[b][c]` (`LIMIT_FIELD_NESTING`)                                                                    |
| `Field name array index too large: <field>`                          | Index over 200, e.g. `chat_ids[1000000000]` (`LIMIT_FIELD_ARRAY_INDEX`)                                   |
| `Invalid field name: <field>`                                        | A name append-field cannot parse (`INVALID_FIELD_NAME`)                                                   |
| `<multer message>[: <field>]`                                        | Any other `MulterError` (generic branch)                                                                  |

### 400 Bad Request, `message` is a string

| Message                                                      | Origin                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `<JSON parser message>`, e.g. `Unexpected end of JSON input` | Express JSON body parser (no `X-Request-Id` on this response) |

### Other statuses

| Status | Message                                                                                                  | Origin                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 403    | `Cross-site requests from web browsers are not allowed`                                                  | `rejectCrossSiteRequests`                                                                                       |
| 404    | `Cannot <METHOD> <path>`                                                                                 | Nest router                                                                                                     |
| 413    | `each file must be at most <N> MB ("<name>" is larger)` (without the parenthesis if multer gave no name) | multipart interceptor (`LIMIT_FILE_SIZE`)                                                                       |
| 413    | `request entity too large` (body `{"statusCode":413,"message":…}`, no `error` field)                     | Express JSON parser, body over 100 KB                                                                           |
| 415    | `Content-Type must be application/json or multipart/form-data`                                           | `requireSupportedBody`                                                                                          |
| 429    | `Too many requests, please try again in <wait>`                                                          | `rateLimitMessage()`; `<wait>` = `N second(s)`, `N minute(s)`, or `N minute(s) N second(s)`, minimum `1 second` |

## 3. Request failed as a whole (500)

| Message                                                                    | Cause                                              | Logged                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| `Telegram delivery is unavailable because of a server configuration error` | Telegram answered 401/404 (bad token) for any call | error `Telegram rejected the bot token; check TELEGRAM_BOT_TOKEN` |
| `Internal server error`                                                    | Any unexpected exception                           | error by `ExceptionsHandler`, with stack                          |

## 4. Per-chat `error` (in `data.results[]`, HTTP 207)

Format: `[Attachment N ("<name>"): ]<reason>[ (after <K> attempts)]`

Reasons from `TelegramApiError` (`src/telegram/telegram.service.ts`):

| Reason (`reason` field)     | Message                                                                              | Delivered?   |
| --------------------------- | ------------------------------------------------------------------------------------ | ------------ |
| `rejected`                  | `Telegram API error <code>: <Telegram description>`                                  | No (refused) |
| `rejected` (group migrated) | `Telegram API error 400: <description> (the group is now chat ID <id>)`              | No           |
| `rate_limited`              | `Rate limited by Telegram; retry after <N> seconds`                                  | No           |
| `rate_limited`              | `Rate limited by Telegram; try again later`                                          | No           |
| `server_error`              | `Telegram server error (HTTP <status>); delivery could not be confirmed`             | Unknown      |
| `timeout`                   | `Telegram did not respond within <ms> ms; delivery could not be confirmed`           | Unknown      |
| `network_error`             | `Could not reach Telegram (<CODE>); delivery could not be confirmed`                 | Unknown      |
| `network_error` (no code)   | `Could not reach Telegram; delivery could not be confirmed`                          | Unknown      |
| `invalid_response`          | `Unexpected response from Telegram (HTTP <status>); delivery could not be confirmed` | Unknown      |
| `unauthorized`              | `Telegram rejected the bot token` (never a per-chat error; becomes the 500 above)    | No           |

Common Telegram descriptions:

| Description                                                 | Meaning                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Bad Request: chat not found`                               | Wrong ID, or the bot never had access to the chat                                |
| `Forbidden: bot was blocked by the user`                    | The user blocked the bot                                                         |
| `Forbidden: bot is not a member of the channel chat`        | The bot was removed, or never added                                              |
| `Bad Request: group chat was upgraded to a supergroup chat` | Use the new ID from the hint                                                     |
| `Bad Request: PHOTO_INVALID_DIMENSIONS`                     | Image ratio or size not allowed as a photo (the service then sends it as a file) |
| `Bad Request: not enough rights to send photos to the chat` | Group permissions (the service then tries a document)                            |

Internal failures (a bug, details only in the log):

| Message                                                            |
| ------------------------------------------------------------------ |
| `Unexpected error while sending the message`                       |
| `Attachment N ("<name>"): Unexpected error while sending the file` |

## 5. Per-chat `warnings` (in `data.results[]`)

| Message                                                                    | Meaning                                 |
| -------------------------------------------------------------------------- | --------------------------------------- |
| `<item>: attempt <K> failed and was retried: <reason>`                     | One per failed attempt that was retried |
| `<item>: sent as a file because Telegram refused it as a photo: <reason>`  | Photo → document fallback               |
| `Message: sent as text on its own because the file could not be delivered` | Caption mode fallback                   |

`<item>` is `Message` or `Attachment N ("<name>")`.

## 6. Log lines (console; warn/error also in the error log)

| Level | Context                | Message                                                                              |
| ----- | ---------------------- | ------------------------------------------------------------------------------------ |
| log   | `Bootstrap`            | `Listening on port <port>`                                                           |
| warn  | `TelegramService`      | `Request to Telegram failed: <CODE>` / `Request to Telegram failed: unknown error`   |
| warn  | `TelegramService`      | `<method> failed (<reason>); retry <n> of <max> in <ms> ms`                          |
| warn  | `NotificationsService` | `Telegram refused "<name>" as a photo for chat <id>; sending it as a file: <reason>` |
| warn  | `NotificationsService` | `Delivery to chat <id> failed: <per-chat error>`                                     |
| error | `NotificationsService` | `Telegram rejected the bot token; check TELEGRAM_BOT_TOKEN`                          |
| error | `NotificationsService` | `Unexpected error while delivering to chat <id>` (+ stack)                           |
| error | `ExceptionsHandler`    | `<exception message>` (+ stack)                                                      |

stderr (not through the logger, printed at most once per process):

| Message                                            | Cause                                        |
| -------------------------------------------------- | -------------------------------------------- |
| `Could not write the error log in <dir>: <reason>` | `ERROR_LOG_DIR` cannot be created or written |

## 7. `test/fire.sh` messages

| Message                                                                | Meaning                    |
| ---------------------------------------------------------------------- | -------------------------- |
| `No requests sent yet.`                                                | Initial state              |
| `-> HTTP <status> in <seconds>s`                                       | Appended to every response |
| `Rate limited after <n> requests:`                                     | Option `g` result header   |
| `Settings updated.`                                                    | After option `s`           |
| `Invalid option. Please select 0-9, a-h or s.`                         | Unknown key                |
| `Settings from: <file>` / `Settings from: defaults (<file> not found)` | Menu header                |
