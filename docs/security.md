# Security

teleHook is **intentionally unauthenticated**. It is meant to run on a private network or behind a reverse proxy that adds authentication. This document covers the threat model, the safeguards in the code, and the rules that keep them working.

## Threat model

Anyone who can reach the HTTP port can:

| Capability                                                       | Impact                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Send any text or file, as the bot, to any chat the bot can reach | Spam, phishing or malware under the bot's name. Reach = every user who started the bot, every group it is in, every channel where it may post. |
| Probe chat IDs                                                   | Per-chat errors reveal whether the bot can reach a chat.                                                                                       |
| Use up Telegram rate limits                                      | Delays real alerts; Telegram may restrict a spamming bot.                                                                                      |
| Use memory and bandwidth                                         | Up to ~2 × 5 × 10 MB = 100 MB of RAM per request and chats × files × size of upload traffic, with defaults.                                    |

Out of scope: authentication, authorization, multi-tenant isolation, encryption in transit (use TLS at a proxy), durable delivery.

## Deployment recommendations

- **Do not expose the port publicly.** The server listens on all interfaces. Use firewall rules or a private network.
- If remote callers need access, put a **reverse proxy** in front with TLS and authentication (IP allow-list, basic auth, mutual TLS).
- Use a **dedicated bot** for this service, added only to the chats it needs.
- **Keep the token secret.** If it leaks, revoke it with `/revoke` in @BotFather and update the environment.
- **Size the limits** (`MAX_ATTACHMENTS_PER_REQUEST`, `MAX_ATTACHMENT_SIZE_MB`, rate limit) for the host's memory and bandwidth.
- **Restrict access to `ERROR_LOG_DIR`.** It contains chat IDs and file names.

## Safeguards

### Token handling

- Read only from the environment, validated at startup by a pattern. The validation message never echoes the value.
- Used only to build the Bot API base URL inside `TelegramService` (`https://api.telegram.org/bot<TOKEN>`).
- **Never** in responses, logs, error messages or warnings:
  - Network errors from `fetch` (undici) can include the request URL, and therefore the token, in their messages. `TelegramService` uses only the error **code** of the cause (`errorCode()`), e.g. `ECONNRESET`, and never `error.message` or `cause.message`.
  - A rejected token becomes HTTP 500 with a fixed message (`Telegram delivery is unavailable because of a server configuration error`) and a fixed log line (`Telegram rejected the bot token; check TELEGRAM_BOT_TOKEN`).
  - Tests check this: `does not echo the bot token in the error` (env validation), `reports network failures without logging the token` (client), `responds 500 without exposing the token when Telegram rejects it` (e2e).
- `test/fire.sh` reads selected keys from `.env` with `sed` and never `source`s it, so the token never enters the script's environment.

### Cross-site protection

Browsers let any web page submit an HTML form to any URL, including `multipart/form-data` and `application/x-www-form-urlencoded`, **without a CORS preflight**. Without protection, a malicious page opened by someone inside your network could make their browser post to `http://10.0.0.5:3000/api/send` and send messages through your bot (cross-site request forgery).

`rejectCrossSiteRequests` (in `notifications.module.ts`) rejects such requests with **403 `Cross-site requests from web browsers are not allowed`**:

```text
if Sec-Fetch-Site is present:
    allow only "same-origin" or "none"
else (older browsers, or plain-HTTP origins other than localhost):
    allow if Origin is absent, or Origin parses as a URL whose host equals the Host header (case-insensitive)
    "Origin: null" (sandboxed/privacy contexts) does not parse → rejected
```

- Modern browsers send `Sec-Fetch-Site` only to secure contexts (HTTPS and localhost). They send `Origin` with every POST, so both cases are covered. This mirrors Go's `net/http` `CrossOriginProtection`.
- **curl, scripts and server-side HTTP clients** (Node `fetch`/undici, Python requests, Go) send neither header and are unaffected. This was verified for curl and Node's `fetch`.
- A non-browser client that sends an `Origin` for another host is rejected. That is rare and fixable on the client.

`requireSupportedBody` then rejects bodies other than `application/json` and `multipart/form-data` with **415**. Before multipart support existed, the API accepted JSON only, which by itself blocked cross-site forms. Multipart is a form encoding, so the explicit cross-site check is now what protects the API.

CORS is not enabled, so browsers also cannot _read_ responses from another origin, and cross-origin `fetch` with JSON fails its preflight.

### Rate limiting

- `@nestjs/throttler`, global guard, **per client IP**: `RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_TTL_MS` (default 10 per minute).
- The guard runs **before** multipart parsing, so a rate-limited client cannot make the server buffer uploads.
- 403/415 rejections happen before the guard and don't count. Everything after it, including 400s, does.
- Counters are **in memory**: they reset on restart and are not shared between instances.
- **Behind a reverse proxy**, all clients share the proxy's IP, and therefore one limit, unless Express `trust proxy` is enabled (e.g. `app.set('trust proxy', 1)` in `main.ts`). Enable it only when a proxy you control is in front; otherwise clients can spoof `X-Forwarded-For` to evade the limit.

### Input validation and limits

- Strict DTO validation: types, chat-ID pattern, no duplicates, no unknown properties, message length (4096 UTF-16 units).
- Recipient limit (`MAX_RECIPIENTS_PER_REQUEST`, max 100).
- Upload limits enforced **while streaming** by multer/busboy: file count, file size, text field count (200) and size (64 KiB), field nesting depth (1), array index (200). The index limit prevents a field like `chat_ids[999999999]` from creating a huge sparse array, which would make later processing expensive.
- Empty files rejected up front.
- JSON bodies are limited to 100 KB by Express.
- Messages are sent **without `parse_mode`**, so markup in user text is never interpreted by Telegram.

### Client-controlled strings

| Input          | Risk                                                         | Handling                                                                                                                             |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| File name      | Log forging via newlines (multer decodes `%0A`), odd display | Base name only (multer default), control characters removed, trimmed, fallback `attachment-N`. Written to logs via `JSON.stringify`. |
| MIME type      | Wrong photo decision                                         | Ignored for decisions (magic bytes are used); passed to Telegram only as the part's content type                                     |
| `X-Request-Id` | Log forging, oversized values                                | Must match `^[\w.-]{1,64}$`, else replaced                                                                                           |
| Message text   | Markup injection                                             | Sent as plain text                                                                                                                   |
| Chat IDs       | —                                                            | Strict numeric pattern                                                                                                               |

### Error disclosure

- Per-chat `error` strings come from `TelegramApiError` messages that are built from fixed templates plus Telegram's own `description`. They are safe to return.
- Unexpected exceptions return generic messages (`Unexpected error while sending the message`, Nest's `Internal server error`), and details go to the log.
- `X-Powered-By` is disabled.

## Rules for contributors

1. Never interpolate `error.message` from `fetch`, undici or their `cause` into anything user-visible or logged. Use `errorCode()`.
2. Never log message text, file contents or the token.
3. Sanitize any new client-controlled string before it reaches a log (or log it with `JSON.stringify` only).
4. Keep `rejectCrossSiteRequests` in front of any route that changes state, and add e2e tests for new routes with `Origin: https://evil.example`.
5. Keep validation complete before the first Telegram call.
6. If you add authentication, apply it as middleware or a guard before the multipart interceptor, so unauthenticated uploads are never buffered.
