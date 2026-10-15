# Telegram client (`TelegramService`)

`src/telegram/telegram.service.ts` is the only code that talks to Telegram. It wraps three Bot API methods, applies a timeout to every call, retries temporary failures, and turns every failure into a `TelegramApiError` with a stable `reason` and a message that is safe to return to API clients.

## Public API

```ts
class TelegramService {
  sendMessage(chatId: string, text: string): Promise<SendResult>;
  sendPhoto(
    chatId: string,
    file: TelegramFile,
    options?: SendFileOptions,
  ): Promise<SendResult>;
  sendDocument(
    chatId: string,
    file: TelegramFile,
    options?: SendFileOptions,
  ): Promise<SendResult>;
}

interface SendResult {
  messageId: number | undefined; // result.message_id from Telegram; undefined if absent
  failedAttempts: string[]; // messages of the attempts that failed before success ([] normally)
}

interface TelegramFile {
  filename: string;
  content: Blob;
} // Attachment satisfies this

interface SendFileOptions {
  caption?: string; // → form field "caption"
  replyToMessageId?: number; // → "reply_parameters": {"message_id":N,"allow_sending_without_reply":true}
  silent?: boolean; // → "disable_notification": "true"
}

class TelegramApiError extends Error {
  readonly reason: TelegramFailureReason;
  readonly retryAfterSeconds?: number; // from Telegram's 429 parameters.retry_after
  readonly failedAttempts: readonly string[]; // attempts before this final failure ([] if no retries)
}

type TelegramFailureReason =
  | 'unauthorized'
  | 'rejected'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'invalid_response';
```

The methods resolve only when Telegram confirms delivery (`HTTP 2xx` and `"ok": true`) and throw a `TelegramApiError` otherwise. Unexpected non-Telegram errors cannot escape `post()`, which wraps transport errors too.

## HTTP requests

| Method         | URL                                               | Body                                                                                                             |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sendMessage`  | `https://api.telegram.org/bot<TOKEN>/sendMessage` | JSON `{"chat_id": "...", "text": "..."}`, header `Content-Type: application/json`                                |
| `sendPhoto`    | `…/sendPhoto`                                     | `FormData`: `chat_id`, `photo` (Blob + filename), optional `caption`, `reply_parameters`, `disable_notification` |
| `sendDocument` | `…/sendDocument`                                  | `FormData`: `chat_id`, `document` (Blob + filename), same optional fields                                        |

- The base URL is the constant `TELEGRAM_API_URL = 'https://api.telegram.org'`. It is not configurable; a local Bot API server would need a code change.
- For `FormData`, no `Content-Type` header is set, so `fetch` adds the multipart type with its boundary.
- The global `fetch` (undici) is used. It sends UTF-8 file names and escapes `"`, CR and LF in them as `%22`, `%0D`, `%0A`.
- `chat_id` is sent as the string from the request.
- No `parse_mode` is ever sent, so text is literal.
- Every attempt has its own `AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS)`, which covers connecting, uploading and reading the response.
- The same `FormData`/`Blob` is reused on retries; `fetch` serializes it again each time. This was verified against a real HTTP server.

## Error classification

`post()` maps every outcome. Transport errors (no HTTP response) come first, then HTTP responses via `toApiError(httpStatus, parsedBody)`, where `code = body.error_code ?? httpStatus`.

| Condition                                                              | `reason`           | Message (exact)                                                                                                                    | Retried?                                       |
| ---------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `fetch` threw `TimeoutError` / `AbortError`                            | `timeout`          | `Telegram did not respond within <ms> ms; delivery could not be confirmed`                                                         | yes (backoff)                                  |
| `fetch` threw anything else                                            | `network_error`    | `Could not reach Telegram (<CODE>); delivery could not be confirmed`, or without ` (<CODE>)` if the cause has no string `code`     | yes (backoff)                                  |
| `code` is 401 or 404                                                   | `unauthorized`     | `Telegram rejected the bot token`                                                                                                  | **no**                                         |
| `code` is 429 with `parameters.retry_after`                            | `rate_limited`     | `Rate limited by Telegram; retry after <N> seconds`                                                                                | yes after `N` s, if `N ≤ 30`; otherwise **no** |
| `code` is 429 without `retry_after`                                    | `rate_limited`     | `Rate limited by Telegram; try again later`                                                                                        | yes (backoff)                                  |
| `code ≥ 500`                                                           | `server_error`     | `Telegram server error (HTTP <status>); delivery could not be confirmed`                                                           | yes (backoff)                                  |
| Not 2xx/ok and no `description` (e.g. HTML from a proxy, or `OK` text) | `invalid_response` | `Unexpected response from Telegram (HTTP <status>); delivery could not be confirmed`                                               | yes (backoff)                                  |
| Anything else with a `description` (400, 403, …)                       | `rejected`         | `Telegram API error <code>: <description>` plus ` (the group is now chat ID <id>)` when `parameters.migrate_to_chat_id` is present | **no**                                         |

Notes:

- Telegram answers **401** for a wrong or revoked token and **404** for a malformed one, so both mean "bad token".
- A 2xx response that is not valid Bot API JSON (`ok` not boolean) is `invalid_response`.
- **`<CODE>` is the error code of `fetch`'s `cause`**, e.g. `ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `UND_ERR_SOCKET` (undici's code when the server closes the socket mid-request). The cause's _message_ is never used, because undici messages can contain the request URL, and the URL contains the token.
- The transport warning `Request to Telegram failed: <CODE or "unknown error">` is logged for every network error.

## Retry policy

```text
call(method, body):
  failedAttempts = []
  for attempt = 1, 2, …:
    try: return { messageId: post(), failedAttempts }
    catch error:
      delay = attempt <= TELEGRAM_MAX_RETRIES ? retryDelayMs(error, attempt) : undefined
      if delay is undefined:
        throw attempt > 1 ? withAttempts(error, failedAttempts) : error
      failedAttempts.push(error.message)
      log warn "<method> failed (<message>); retry <attempt> of <max> in <delay> ms"
      sleep(delay)
```

`retryDelayMs(error, attempt)`:

| Reason                                                                                               | Delay                                              |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `timeout`, `network_error`, `server_error`, `invalid_response`, `rate_limited` without `retry_after` | `1000 × 2^(attempt−1)` ms → 1 s, 2 s, 4 s, 8 s, …  |
| `rate_limited` with `retry_after ≤ 30`                                                               | `retry_after × 1000` ms                            |
| `rate_limited` with `retry_after > 30`                                                               | final (fail now; don't hold the HTTP request open) |
| `rejected`, `unauthorized`, non-`TelegramApiError`                                                   | final                                              |

- `TELEGRAM_MAX_RETRIES` (default 3, range 0–10) is the number of _retries_, so there are at most `1 + max` attempts. `0` restores at-most-once behaviour.
- **Final failure after retries** (`withAttempts`): a new `TelegramApiError` with the same `reason` and `retryAfterSeconds`, the message suffixed with ` (after <attempts> attempts)`, and `failedAttempts` holding the earlier messages. This also happens when a later attempt fails with a non-retryable reason, e.g. a refusal after one network retry gives `… (after 2 attempts)`.
- **Success after retries:** `SendResult.failedAttempts` lists why the earlier attempts failed. `NotificationsService` turns them into warnings.
- No jitter. Delays are deterministic, which keeps tests simple.

### Why delivery-unknown failures are retried

A timeout, dropped connection or 5xx means Telegram **may** have delivered the message. Retrying can therefore produce a duplicate. For an alerting service, a duplicate alert is far better than a lost one, so these are retried. A refusal (`rejected`) or a bad token cannot succeed on retry, so those are never retried. A 429 guarantees nothing was sent, so retrying after `retry_after` is always safe. See [decisions.md](decisions.md#d6-retry-transient-failures-accept-duplicates).

### Worst-case duration of one call

`(1 + maxRetries) × timeout + Σ backoff`. With the defaults: `4 × 10 s + (1 + 2 + 4) s = 47 s`. With rate limiting, each wait can be up to 30 s instead.

## Logging (context `TelegramService`)

| Level | Message                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------- |
| warn  | `Request to Telegram failed: <CODE>` (`unknown error` if no code), for every network error      |
| warn  | `<method> failed (<error message>); retry <attempt> of <max> in <delay> ms`, before every retry |

Timeouts and HTTP errors are not logged here. The caller (`NotificationsService`) logs final failures.

## Testing the client

`src/telegram/telegram.service.spec.ts` stubs the global `fetch` with `vi.fn()` and builds `Response` objects (`telegramResponse`, `delivered`, `failure`, `rateLimited` helpers). Retry tests use `vi.useFakeTimers({ toFake: ['setTimeout'] })` and `vi.advanceTimersByTimeAsync`. `createService(timeoutMs = 1000, maxRetries = 0)` keeps retries off unless a test asks for them. The `formFields(init)` helper reads a `FormData` body back as plain values, with files as `{ filename, text }`.

## Extending the client

- **New Bot API method:** add a public method that builds the body and calls `this.call('<method>', body)`. Keep the same outcome contract (`SendResult` or `TelegramApiError`).
- **New failure class:** add it to `TelegramFailureReason`, map it in `toApiError`/`toTransportError`, and decide its retry behaviour in `retryDelayMs`. Then document it here and in [error-catalog.md](error-catalog.md).
- **Never** put `error.message` from `fetch` or its `cause` into an error, warning or log. Use `errorCode()`.
