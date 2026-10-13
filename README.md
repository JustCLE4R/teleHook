<p align="center"><img src="pinglet.png" width="96" alt="Pinglet logo"></p>

# Pinglet

A minimal NestJS REST API that sends a Telegram message to the chat IDs supplied in each request.

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

| Variable                      | Default  | Description                                     |
| ----------------------------- | -------- | ----------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`          | required | Bot token from @BotFather (`<bot id>:<secret>`) |
| `PORT`                        | `3000`   | HTTP port                                       |
| `MAX_RECIPIENTS_PER_REQUEST`  | `20`     | Maximum chat IDs per request (1–100)            |
| `TELEGRAM_REQUEST_TIMEOUT_MS` | `10000`  | Timeout for each Telegram API call (1000–60000) |
| `RATE_LIMIT_TTL_MS`           | `60000`  | Rate-limit window                               |
| `RATE_LIMIT_MAX_REQUESTS`     | `10`     | Requests allowed per client IP per window       |

Variables are validated at startup. If one is missing or invalid, the app exits with code 1 and a message naming the variable. The token value is never printed. Real environment variables take precedence over values in `.env`.

## Running

```bash
npm run start:dev                       # development, restarts on file changes
npm run build && npm run start:prod     # production build
```

## API

### `POST /api/send`

`Content-Type: application/json` is required.

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

### Status codes

| Status | Meaning                                                                                     |
| ------ | ------------------------------------------------------------------------------------------- |
| 200    | Every message was delivered                                                                 |
| 207    | At least one delivery failed (some or all). See `data.results` for the outcome of each chat |
| 400    | Malformed JSON, failed validation, or too many recipients                                   |
| 415    | `Content-Type` is not `application/json`                                                    |
| 429    | Rate limit exceeded; the `Retry-After` header gives the wait in seconds                     |
| 500    | Telegram rejected the configured bot token, or an unexpected server error occurred          |

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

**400: validation error**

```json
{
  "message": ["chat_ids must not contain duplicates"],
  "error": "Bad Request",
  "statusCode": 400
}
```

Common per-chat `error` values:

| Error                                                                       | What it means                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `Telegram API error 400: Bad Request: chat not found`                       | Wrong ID, or the bot has never had access to that chat             |
| `Telegram API error 403: Forbidden: bot was blocked by the user`            | The user blocked the bot                                           |
| `Rate limited by Telegram; retry after N seconds`                           | Not delivered; safe to retry after N seconds                       |
| `Telegram did not respond within 10000 ms; delivery could not be confirmed` | May or may not have been delivered; a retry could send a duplicate |
| `Could not reach Telegram; delivery could not be confirmed`                 | Network failure; may or may not have been delivered                |

### Delivery behaviour

- Messages are sent with at most 5 Telegram requests in flight per API call. Results are returned in request order.
- A failed chat never stops delivery to the other chats.
- Only HTTP 429 is retried, because Telegram guarantees a rate-limited message was not sent. It is retried once, after the `retry_after` delay, and only if that delay is 5 seconds or less. Longer waits fail that chat immediately with the retry time.
- Timeouts, network errors and Telegram 5xx responses are never retried. The message may already have been delivered, so the caller decides whether to resend.
- If Telegram rejects the bot token, the remaining chats are skipped and the API responds 500.

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

- **Send any text, as your bot, to any chat the bot can reach.** That includes every user who started the bot, every group it belongs to, and every channel where it can post. This enables spam or phishing under your bot's name.
- **Probe chat IDs.** Per-chat errors show whether the bot can reach a given chat.
- **Use up Telegram's rate limits**, delaying legitimate messages. Telegram may restrict or ban bots that send spam.

Recommendations:

- Do not expose the service to the public internet. The server listens on all network interfaces, so restrict access with firewall rules or a private network.
- If remote callers need access, put a reverse proxy in front that adds TLS and authentication (an IP allow-list, basic auth or mutual TLS).
- Use a dedicated bot for this service and add it only to the chats it needs.
- Keep the token secret. If it leaks, revoke it with `/revoke` in @BotFather and update `.env`.

Built-in safeguards:

- **Per-IP rate limit**, 10 requests per minute by default. Counters live in memory, so they reset on restart and are not shared between instances. Behind a reverse proxy, all clients share the proxy's IP, and therefore one limit, unless Express's `trust proxy` setting is enabled (for example `app.set('trust proxy', 1)` in `src/main.ts`). Enable it only when a proxy you control is in front: otherwise clients can spoof `X-Forwarded-For` to evade the limit.
- **JSON-only requests.** Other content types get 415. Without this, any web page could make a visitor's browser submit a cross-site HTML form that sends messages through an instance on their network. CORS is not enabled, so browsers also block cross-origin JSON requests.
- **Strict validation.** Recipient count is limited, unknown fields are rejected, and messages are sent as plain text.
- **Token handling.** The token is read only from the environment and validated at startup. It never appears in responses or logs. Failed deliveries are logged with the chat ID and reason, never the message text.

## Project structure

```text
src/
├── main.ts                          # bootstrap: reads PORT and starts the server
├── app.module.ts                    # configuration, rate limiter, global validation pipe
├── config/
│   └── env.validation.ts            # environment schema, validated at startup
├── telegram/
│   ├── telegram.module.ts
│   └── telegram.service.ts          # Bot API client: timeout, error mapping, 429 retry
└── notifications/
    ├── notifications.module.ts      # also restricts the route to JSON bodies
    ├── notifications.controller.ts  # POST /api/send
    ├── notifications.service.ts     # recipient limit, bounded concurrency, results
    └── dto/
        └── send-notification.dto.ts # request validation
test/
├── notifications.e2e-spec.ts
└── setup.ts                         # blocks real network calls in tests
```
