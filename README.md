<p align="center"><img src="assets/favicon.svg" width="96" alt="teleHook logo"></p>

# teleHook

A minimal NestJS REST API that sends a Telegram message, optionally with files such as screenshots, graphs, logs or diagnostic reports, to the chat IDs supplied in each request.

There is no database, no stored state and no authentication. Recipients come only from the request payload, and delivery results exist only in the response.

## Prerequisites

- Node.js 20.19+, 22.12+ or 24+ (the service uses the built-in `fetch`)
- npm
- A Telegram bot token (see [Telegram setup](#telegram-setup))

## Installation

```bash
npm install
cp .env.example .env    # PowerShell: Copy-Item .env.example .env
```

Then set `TELEGRAM_BOT_TOKEN` in `.env`. The `.env` file is git-ignored; only `.env.example` (placeholders) is committed.

## Configuration

| Variable                      | Default  | Description                                                                                     |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`          | required | Bot token from @BotFather (`<bot id>:<secret>`)                                                 |
| `PORT`                        | `3000`   | HTTP port                                                                                       |
| `MAX_RECIPIENTS_PER_REQUEST`  | `20`     | Maximum chat IDs per request (1–100)                                                            |
| `MAX_ATTACHMENTS_PER_REQUEST` | `5`      | Maximum files per request (1–10)                                                                |
| `MAX_ATTACHMENT_SIZE_MB`      | `10`     | Maximum size of each file, in MB (1–50; Telegram accepts bot uploads up to 50 MB)               |
| `TELEGRAM_REQUEST_TIMEOUT_MS` | `10000`  | Timeout for each Telegram API call, including each file upload (1000–60000)                     |
| `TELEGRAM_MAX_RETRIES`        | `3`      | Retries for each Telegram call that fails for a temporary reason (0–10; 0 disables retrying)    |
| `ERROR_LOG_DIR`               | `logs`   | Directory for the [error log](#error-log), relative to the working directory; empty disables it |
| `ERROR_LOG_RETENTION_DAYS`    | `30`     | Days of error log files to keep (1–3650)                                                        |
| `RATE_LIMIT_TTL_MS`           | `60000`  | Rate-limit window                                                                               |
| `RATE_LIMIT_MAX_REQUESTS`     | `10`     | Requests allowed per client IP per window                                                       |

Variables are validated at startup. If one is missing or invalid, the app exits with code 1 and a message naming the variable. The token value is never printed. Real environment variables take precedence over values in `.env`.

## Running

```bash
npm run dev                       # development, restarts on file changes
npm run build && npm run prod     # production build
```

## API

### `POST /api/send`

Send a JSON body for a text message, or a `multipart/form-data` body to [attach files](#attaching-files) to it.

```json
{
  "chat_ids": ["123456789", "-1001234567890"],
  "message": "Server is down!"
}
```

| Field      | Type     | Rules                                                                                                                                                                     |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_ids` | string[] | 1 to `MAX_RECIPIENTS_PER_REQUEST` entries. Each is a numeric chat ID as a string: optional leading `-`, no leading zeros, at most 16 digits. `@username` is not accepted. |
| `message`  | string   | At least one non-whitespace character; at most 4096 characters, counted as UTF-16 code units (most emoji count as 2). Sent as plain text, exactly as given.               |

- **Duplicate chat IDs are rejected** with 400 rather than silently removed, so `data.results` always matches the request one-to-one.
- Unknown properties are rejected with 400.
- Messages are sent without `parse_mode`, so HTML or Markdown in the text is delivered literally.

### Attaching files

Send the same fields as a `multipart/form-data` form, and attach each file in a field named `files`:

```bash
curl http://localhost:3000/api/send \
  -F chat_ids=123456789,-1001234567890 \
  -F "message=High CPU on web-1" \
  -F files=@cpu.png \
  -F files=@top.txt
```

| Field      | Rules                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_ids` | As in JSON. Repeat the field for each chat, or list the IDs separated by commas. `chat_ids[]` fields also work.                                                       |
| `message`  | As in JSON. Required, also when files are attached.                                                                                                                   |
| `files`    | Optional. Up to `MAX_ATTACHMENTS_PER_REQUEST` files (default 5), one `files` field each. Each must be non-empty and at most `MAX_ATTACHMENT_SIZE_MB` (default 10 MB). |

**One file:** each chat receives a single post, the file with the message as its caption. Telegram limits captions to 1024 characters, so a longer message is sent as with several files. If the file cannot be delivered, even after retries, the message is still sent as text, and the result reports the file's error.

**Several files:** each chat receives:

1. **The message**, exactly as for a JSON request. It goes first, so the alert arrives even if an upload fails.
2. **Each file, in upload order**, without a caption, as a reply to the message and without a notification sound. The files stay attached to their alert in a busy chat, and each alert notifies once.

Either way:

- JPEG and PNG images of up to 10 MB are sent as **photos**: shown inline and compressed by Telegram. If Telegram refuses an image as a photo, for example a very tall screenshot, it is sent as a file instead.
- Everything else, including other image formats, is sent as a **file**, unchanged, under its original name.

The request is validated as a whole before anything is sent. An empty file, a file over the size limit, or too many files rejects the request, **message included**. Scripts should attach only non-empty files within the limit, as in the example below.

curl tips:

- `-F "files=@-;filename=ps.txt"` uploads standard input: `ps aux | curl ... -F "files=@-;filename=ps.txt"`.
- `-F` treats a value starting with `@` or `<` as a file. Pass text from variables with `--form-string "message=$TEXT"`, or read the message from a file with `-F "message=<alert.txt"`.
- Windows 10, and Windows Server 2019 and later, include `curl.exe`. Windows PowerShell 5.1's `Invoke-RestMethod` cannot send multipart forms.

#### Example: attach a server snapshot to an alert

```bash
#!/usr/bin/env bash
# Sends an alert with a snapshot of this server attached.
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

{
  echo "== uptime"; uptime
  echo "== memory"; free -m
  echo "== disk"; df -h
  echo "== top processes"; ps aux --sort=-%cpu | head -n 15
} > "$dir/diagnostics.txt" 2>&1
# Only the end of the log, so the file stays within MAX_ATTACHMENT_SIZE_MB.
tail -n 200 /var/log/nginx/error.log > "$dir/nginx-error.log" 2>/dev/null
# Images work the same way, e.g. a graph saved as PNG by Grafana's render API.

files=()
for file in "$dir"/*; do
  # An empty file would reject the whole request, alert included.
  [ -s "$file" ] && files+=(-F "files=@$file")
done

curl -sS http://telehook.internal:3000/api/send \
  -F "chat_ids=$TELEGRAM_CHAT_IDS" \
  --form-string "message=🔥 High CPU on $(hostname)" \
  "${files[@]}"
```

`TELEGRAM_CHAT_IDS` holds one or more chat IDs, such as `123456789,-1001234567890`.

### Status codes

| Status | Meaning                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | Every chat received the message and all files                                                                                                                                |
| 207    | At least one delivery failed (some or all). See `data.results` for the outcome of each chat                                                                                  |
| 400    | Malformed JSON or form, failed validation, too many recipients or files, or an empty file                                                                                    |
| 403    | A web browser sent the request on behalf of another site (see [Security considerations](#security-considerations))                                                           |
| 413    | A file is larger than `MAX_ATTACHMENT_SIZE_MB`                                                                                                                               |
| 415    | `Content-Type` is neither `application/json` nor `multipart/form-data`                                                                                                       |
| 429    | Rate limit exceeded. The `Retry-After` header gives the wait in seconds, and the message says it in words, e.g. `Too many requests, please try again in 1 minute 25 seconds` |
| 500    | Telegram rejected the configured bot token, or an unexpected server error occurred                                                                                           |

The top-level `success` field is `true` only when every delivery succeeded.

### Examples

```bash
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "chat_ids": ["123456789"],
    "message": "Hello from NestJS!"
  }'
```

In Windows PowerShell, `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe`, or:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/send `
  -ContentType 'application/json' `
  -Body '{"chat_ids":["123456789"],"message":"Hello from NestJS!"}'
```

**200: all delivered**

```json
{
  "success": true,
  "message": "Notification processing completed",
  "data": {
    "total": 2,
    "sent": 2,
    "failed": 0,
    "results": [
      { "chat_id": "123456789", "success": true },
      { "chat_id": "-1001234567890", "success": true }
    ]
  }
}
```

**207: partial failure**

```json
{
  "success": false,
  "message": "Notification processing completed with failures",
  "data": {
    "total": 2,
    "sent": 1,
    "failed": 1,
    "results": [
      { "chat_id": "123456789", "success": true },
      {
        "chat_id": "-1001234567890",
        "success": false,
        "error": "Telegram API error 403: Forbidden: bot is not a member of the channel chat"
      }
    ]
  }
}
```

**200 with warnings: delivered, but not smoothly**

A chat's result has a `warnings` list when something went wrong along the way without stopping delivery: an attempt that failed and was [retried](#delivery-behaviour), a photo sent as a file, or a message sent as text because its file could not be delivered. The list is left out when there is nothing to report. Failed deliveries can have warnings too, listing the attempts before the final one.

```json
{
  "success": true,
  "message": "Notification processing completed",
  "data": {
    "total": 1,
    "sent": 1,
    "failed": 0,
    "results": [
      {
        "chat_id": "123456789",
        "success": true,
        "warnings": [
          "Message: attempt 1 failed and was retried: Could not reach Telegram (ECONNRESET); delivery could not be confirmed"
        ]
      }
    ]
  }
}
```

Warnings show a problem early, such as a flaky connection to Telegram, before it starts losing alerts. The same events are in the [error log](#error-log) with more detail.

**400: validation error**

```json
{
  "message": ["chat_ids must not contain duplicates"],
  "error": "Bad Request",
  "statusCode": 400
}
```

Common per-chat `error` values:

| Error                                                                       | What it means                                                                                                         |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Telegram API error 400: Bad Request: chat not found`                       | Wrong ID, or the bot has never had access to that chat                                                                |
| `Telegram API error 403: Forbidden: bot was blocked by the user`            | The user blocked the bot                                                                                              |
| `Rate limited by Telegram; retry after N seconds`                           | Not delivered; safe to retry after N seconds                                                                          |
| `Telegram did not respond within 10000 ms; delivery could not be confirmed` | Still failing after all retries; may or may not have been delivered                                                   |
| `Could not reach Telegram (ECONNRESET); delivery could not be confirmed`    | Network failure that outlasted the retries, with the error code when there is one; may or may not have been delivered |
| `Attachment 2 ("top.txt"): <one of the errors above>`                       | The message and the files before this one were delivered; later files were not attempted                              |

### Delivery behaviour

- Up to 5 chats are served at a time. Each chat receives its message and files one after another. Results are returned in request order.
- A failed chat never stops delivery to the other chats.
- Within a chat, delivery stops at the first failure. Everything before the failed item was delivered, and its error names the file if it was not the message. With a single captioned file, `Attachment 1 (...)` means the file failed and the message was then sent as text.
- Calls that fail for a temporary reason are retried up to `TELEGRAM_MAX_RETRIES` times (default 3): dropped connections such as `ECONNRESET`, timeouts, Telegram 5xx responses and unreadable responses wait 1, 2, then 4 seconds; HTTP 429 waits the `retry_after` Telegram asks for, if that is 30 seconds or less. A final failure says how many attempts were made, e.g. `(after 4 attempts)`. Refusals, such as an unknown chat, are never retried.
- **Retries favour delivery over uniqueness.** After a timeout or dropped connection the message may already have arrived, so a retry can deliver it twice. For alerts, a duplicate is better than a lost message. Set `TELEGRAM_MAX_RETRIES=0` to never risk duplicates.
- Retries keep the HTTP request open: with the defaults, one Telegram call can take up to about 47 seconds (4 attempts of 10 seconds plus 7 seconds of waiting). Give callers a generous timeout. `TELEGRAM_REQUEST_TIMEOUT_MS` applies to each upload too; raise it if large files time out on a slow link.
- If Telegram rejects the bot token, the remaining chats are skipped and the API responds 500.

## Error log

Warnings and errors are printed to the console as before, and also appended to a daily file in `ERROR_LOG_DIR`, `errors-YYYY-MM-DD.jsonl` (UTC dates), one JSON object per line. Files older than `ERROR_LOG_RETENTION_DAYS` are deleted. If the file cannot be written, this is reported once on stderr and the service keeps running.

```json
{
  "time": "2026-10-14T22:56:00.161Z",
  "level": "warn",
  "context": "TelegramService",
  "request_id": "cpu-check-web1",
  "message": "sendPhoto failed (Could not reach Telegram; delivery could not be confirmed); retry 2 of 3 in 2000 ms"
}
```

| Field        | Meaning                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| `time`       | When it happened (UTC)                                                                    |
| `level`      | `warn` for retries and failed deliveries, `error` for configuration and unexpected errors |
| `context`    | The part of the service that logged it, e.g. `TelegramService`                            |
| `request_id` | The API request it belongs to; absent for startup messages                                |
| `message`    | What went wrong. Never contains the bot token, message text or file contents              |
| `stack`      | Stack trace, for unexpected errors                                                        |

Every response carries an `X-Request-Id` header with the ID that its log lines use. Send your own `X-Request-Id` (letters, digits, `_`, `.` and `-`, up to 64 characters), such as the name of the check, to find a request's lines later; other values are replaced by a generated ID.

Summaries with [jq](https://jqlang.org/), to see what fails most and where to improve:

```bash
# Most frequent problems, with numbers blanked out so similar lines group together
jq -r '.message | gsub("[0-9]+"; "N")' logs/errors-*.jsonl | sort | uniq -c | sort -rn | head

# Network errors per hour, such as ECONNRESET
jq -r 'select(.message | startswith("Request to Telegram failed")) | .time[0:13] + " " + .message' logs/errors-*.jsonl | sort | uniq -c

# Everything that happened during one request
jq 'select(.request_id == "cpu-check-web1")' logs/errors-*.jsonl

# Deliveries that failed after all retries
jq -r 'select(.message | startswith("Delivery to chat")) | .time + " " + .message' logs/errors-*.jsonl
```

## Telegram setup

### Create a bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Follow the prompts, then put the token it gives you into `.env` as `TELEGRAM_BOT_TOKEN`.

### Find a chat ID

Bots cannot start conversations, so each recipient must first make the bot reachable. Then call `getUpdates` and read the chat ID from the response:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
```

| Chat type    | Make it reachable                                                                                                 | Where the ID appears                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Private chat | Open the bot and press **Start**                                                                                  | `message.chat.id` (positive)                |
| Group        | Add the bot, then send `/start@your_bot` in the group (with privacy mode on, the default, bots only see commands) | `message.chat.id` (negative)                |
| Channel      | Add the bot as an administrator that can post messages, then post in the channel                                  | `channel_post.chat.id` (starts with `-100`) |

`getUpdates` only returns updates from the last 24 hours, and it does not work while a webhook is set on the bot. When a group is upgraded to a supergroup, its chat ID changes; the error for the old ID includes the new one.

## Testing

```bash
npm test             # unit tests
npm run test:e2e     # end-to-end tests against the full application
npm run test:cov     # unit tests with coverage
npm run lint
npm run build
```

Telegram HTTP calls are mocked in every test. A shared setup file (`test/setup.ts`) makes any unmocked `fetch` fail, so tests can never send a real message. The e2e suite uses fixed settings from `vitest.config.e2e.ts`, which override any local `.env`.

## Security considerations

The endpoint is intentionally unauthenticated. Anyone who can reach it can:

- **Send any text or file, as your bot, to any chat the bot can reach.** That includes every user who started the bot, every group it belongs to, and every channel where it can post. This enables spam, phishing or malware under your bot's name.
- **Probe chat IDs.** Per-chat errors show whether the bot can reach a given chat.
- **Use up Telegram's rate limits**, delaying legitimate messages. Telegram may restrict or ban bots that send spam.
- **Use up memory and bandwidth.** Uploaded files stay in memory until the request completes, at about twice their size while they are sent, and each file is uploaded to Telegram once per chat. With the defaults, one request can hold about 100 MB and upload up to 1 GB.

Recommendations:

- Do not expose the service to the public internet. The server listens on all network interfaces, so restrict access with firewall rules or a private network.
- If remote callers need access, put a reverse proxy in front that adds TLS and authentication (an IP allow-list, basic auth or mutual TLS).
- Use a dedicated bot for this service and add it only to the chats it needs.
- Keep the token secret. If it leaks, revoke it with `/revoke` in @BotFather and update `.env`.

Built-in safeguards:

- **Per-IP rate limit**, 10 requests per minute by default. Counters live in memory, so they reset on restart and are not shared between instances. Behind a reverse proxy, all clients share the proxy's IP, and therefore one limit, unless Express's `trust proxy` setting is enabled (for example `app.set('trust proxy', 1)` in `src/main.ts`). Enable it only when a proxy you control is in front: otherwise clients can spoof `X-Forwarded-For` to evade the limit.
- **No cross-site browser requests.** HTML forms can post multipart bodies to any site without a CORS preflight, so without this check any web page could make a visitor's browser send messages through an instance on their network. Browsers mark such requests with the `Sec-Fetch-Site` or `Origin` header, and the API rejects them with 403. curl and server-side HTTP clients send neither header. Bodies other than JSON and multipart get 415, and CORS is not enabled, so browsers also block cross-origin JSON requests.
- **Strict validation.** The number of recipients and files and the size of each file are limited, unknown fields are rejected, and messages are sent as plain text. Lower `MAX_ATTACHMENTS_PER_REQUEST` and `MAX_ATTACHMENT_SIZE_MB` on servers with little memory.
- **Token handling.** The token is read only from the environment and validated at startup. It never appears in responses or logs. Failed deliveries are logged, to the console and the error log, with the chat ID, the reason and the file name if a file failed, never the message text or file contents. Chat IDs and file names do appear in the error log, so restrict access to `ERROR_LOG_DIR`.

## Project structure

```text
src/
├── main.ts                          # bootstrap: reads PORT and starts the server
├── app.module.ts                    # configuration, global validation pipe
├── config/
│   └── env.validation.ts            # environment schema, validated at startup
├── rate-limit/
│   ├── rate-limit.module.ts         # per-IP rate limit for every route
│   └── rate-limit-message.ts        # 429 message with the wait, e.g. "try again in 42 seconds"
├── logging/
│   ├── error-file.logger.ts         # console logger that also writes the error log files
│   ├── request-context.ts           # request IDs, shared with every log line of a request
│   └── logging.module.ts
├── telegram/
│   ├── telegram.module.ts
│   └── telegram.service.ts          # Bot API client: messages and uploads, timeout, error mapping, 429 retry
└── notifications/
    ├── notifications.module.ts      # also rejects cross-site browser requests and unsupported bodies
    ├── notifications.controller.ts  # POST /api/send
    ├── notifications.service.ts     # recipient limit, bounded concurrency, delivery order, results
    ├── multipart-form.interceptor.ts # parses forms with files, upload limits
    ├── attachment.ts                # photo detection, file name cleanup
    └── dto/
        └── send-notification.dto.ts # request validation
test/
├── notifications.e2e-spec.ts
└── setup.ts                         # blocks real network calls in tests
```
