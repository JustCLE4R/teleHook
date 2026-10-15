# API reference

The complete HTTP contract of teleHook. Every message string below is copied from the source; [error-catalog.md](error-catalog.md) lists them all by origin.

There is exactly one endpoint. Any other method or path returns Nest's 404, e.g. `{"message":"Cannot GET /api/send","error":"Not Found","statusCode":404}`.

## `POST /api/send`

Sends `message` to every chat in `chat_ids`, optionally followed by files. Responds after all deliveries finish (synchronously), with the outcome for each chat.

### Request formats

| Content-Type          | Use for                            | Files                                                              |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `application/json`    | Text-only messages                 | Not supported                                                      |
| `multipart/form-data` | Messages with files (or text only) | `files` field                                                      |
| none (no body)        | —                                  | Passes the content-type check; validation then rejects it with 400 |
| anything else         | —                                  | **415**                                                            |

### JSON body

```json
{
  "chat_ids": ["123456789", "-1001234567890"],
  "message": "Server is down!"
}
```

| Field      | Type       | Rules (checked in this order; the first failure per field is reported)                                                                                                                          |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_ids` | `string[]` | Must be an array → not empty → every entry a string → every entry matches `^-?[1-9]\d{0,15}$` → no duplicates. Then, in the service: at most `MAX_RECIPIENTS_PER_REQUEST` entries (default 20). |
| `message`  | `string`   | Must be a string → contain at least one non-whitespace character (`/\S/`) → at most **4096 UTF-16 code units** (`string.length`; most emoji count as 2).                                        |

- **Chat IDs** are numeric strings: positive for users, negative for groups, `-100…` for supergroups and channels. No leading zeros, at most 16 digits, no `+`, no spaces, no `@username`. Numbers (not strings) are rejected: `each chat ID must be a string`.
- **Duplicates are rejected** (400), not removed, so `data.results` always matches `chat_ids` one-to-one.
- **Unknown properties are rejected** (`property parse_mode should not exist`) because the pipe uses `forbidNonWhitelisted`.
- **Messages are sent as plain text**, with no `parse_mode`, so HTML/Markdown arrives literally and is never interpreted.
- **A JSON array body** (`[...]`) is rejected with 400.
- **The JSON body limit is 100 KB** (Express default). Larger bodies get `413 {"statusCode":413,"message":"request entity too large"}`.
- **Malformed JSON** gets `400 {"message":"<parser message>","error":"Bad Request","statusCode":400}`, e.g. `Unexpected end of JSON input`.

### Multipart body

Same fields, sent as form fields, plus files:

| Field      | Rules                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_ids` | Same validation as JSON after normalization. Accepted forms: one field (`chat_ids=123`), repeated fields (`chat_ids=1`, `chat_ids=2`), a comma-separated list (`chat_ids=1,-100…`, spaces around commas are trimmed), bracket fields as axios sends them (`chat_ids[]=1`, `chat_ids[0]=1`). Mixed forms are flattened, e.g. `chat_ids=1` + `chat_ids=2, 3` → `["1","2","3"]`. |
| `message`  | Same as JSON. Required even with files. Repeating the field makes it an array → `message must be a string`.                                                                                                                                                                                                                                                                   |
| `files`    | Optional. 0 to `MAX_ATTACHMENTS_PER_REQUEST` file parts (default 5), each named `files`, each **non-empty** and at most `MAX_ATTACHMENT_SIZE_MB` MiB (default 10).                                                                                                                                                                                                            |

Normalization details (`normalizeChatIds` in `multipart-form.interceptor.ts`):

- Runs only for multipart requests. JSON `chat_ids` must already be an array.
- A string becomes `[string]`. An array is copied with `Array.from`, which turns gaps (from `chat_ids[5]=…`) into `undefined` entries that validation rejects (`each chat ID must be a string`). Then every string entry is split on `,` and trimmed.
- An empty entry (`"1,"`, `"1,,2"`, `""`) is kept as `""` and fails the chat-ID pattern. Trailing commas are not forgiven.
- Missing or object-valued `chat_ids` is left alone for validation to report.

multer limits and settings (`MultipartFormInterceptor`):

| Setting                            | Value                                           | Error when exceeded                                                      |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| Storage                            | memory (`multer.memoryStorage()`)               | —                                                                        |
| `defParamCharset`                  | `utf8` (UTF-8 file names are decoded correctly) | —                                                                        |
| `files`                            | `MAX_ATTACHMENTS_PER_REQUEST`                   | 400 `files must contain at most N files`                                 |
| `fileSize`                         | `MAX_ATTACHMENT_SIZE_MB × 1024 × 1024` bytes    | 413 `each file must be at most N MB ("name" is larger)`                  |
| `fields` (text fields)             | 200                                             | 400 `Too many fields`                                                    |
| `fieldSize`                        | 64 KiB per text field                           | 400 `Field value too long: message`                                      |
| `fieldNestingDepth`                | 1 (`a[b]` OK, `a[b][c]` not)                    | 400 `Field name nesting too deep: <name>`                                |
| `fieldArrayIndexLimit`             | 200                                             | 400 `Field name array index too large: <name>`                           |
| File in a field other than `files` | —                                               | 400 `unexpected file in field "<field>"; only "files" may contain files` |

Further multipart checks, after parsing:

- A _text_ field named `files` (e.g. `curl -F files=report.txt`, which sends the name, not the file): 400 `files must be file uploads, not text fields`.
- An empty file: 400 `each file must not be empty ("<name>" is empty)`. Telegram refuses empty files, so the request is rejected up front.
- A broken body (truncated, no boundary): 400 `malformed multipart body: <busboy message>`, e.g. `Unexpected end of form`, `Multipart: Boundary not found`.
- A file part with an empty `filename=""` is silently ignored by multer (as browsers send for an empty file input).

File naming:

- The name is the client's `filename` (base name only; multer strips paths), with control characters (`\p{Cc}`) removed and whitespace trimmed. If nothing is left, the name becomes `attachment-N` (N = 1-based position).
- curl sends `filename="-"` for `-F files=@-` (stdin). Use `-F "files=@-;filename=ps.txt"` to name it.
- The client's MIME type is passed on to Telegram as the part's content type but is **not** trusted for the photo decision, which uses the file's leading bytes. See [delivery.md](delivery.md#photo-or-document).

### Validation order

Everything is validated before any Telegram call. If a request is rejected for any reason, nothing was sent.

1. Body parsing (JSON) → 400 / 413
2. Cross-site check → 403
3. Content type → 415
4. Rate limit → 429
5. Multipart parsing and upload checks → 400 / 413
6. DTO validation → 400 (one message per invalid field)
7. Recipient count → 400

Within step 6, the pipe uses `stopAtFirstError`, so each property reports only its first failing rule, but all invalid properties are reported. `{}` gives:

```json
{
  "message": [
    "chat_ids must be an array of chat ID strings",
    "message must be a string"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

### Successful and partial responses

```ts
{
  success: boolean; // true only if every chat succeeded
  message: 'Notification processing completed' |
    'Notification processing completed with failures';
  data: {
    total: number; // = chat_ids.length
    sent: number; // results with success: true
    failed: number; // results with success: false
    results: Array<{
      chat_id: string; // as given in the request (after multipart normalization)
      success: boolean;
      error?: string; // only when success is false
      warnings?: string[]; // only when non-empty; may appear with success true or false
    }>;
  }
}
```

| HTTP status          | When                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| **200**              | `failed === 0`. Every chat received the message and all files. Warnings may still be present. |
| **207 Multi-Status** | `failed > 0`. Some or all chats failed. Check each `results[]` entry.                         |

`results` is in request order. `chat_id` is the string from the request.

#### `error` format

`error` is a human-readable string. It is safe to show (it never contains the token) and stable enough to match on its prefix:

- Failure of the message: `<reason>`, e.g. `Telegram API error 403: Forbidden: bot was blocked by the user`.
- Failure of an attachment: `Attachment N ("<name>"): <reason>`. In reply mode, the message and attachments 1…N−1 were delivered, and later attachments were not attempted. In caption mode (one file), see [delivery.md](delivery.md#caption-mode).
- After retries, the reason ends with ` (after N attempts)`.
- An unexpected internal error: `Unexpected error while sending the message` or `Attachment N ("<name>"): Unexpected error while sending the file`.

Reason strings by cause are in [telegram-client.md](telegram-client.md#error-classification).

#### `warnings` format

Each entry is `<item>: <text>`, where `<item>` is `Message` or `Attachment N ("<name>")`:

| Warning                                                                    | Meaning                                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `<item>: attempt K failed and was retried: <reason>`                       | Attempt K of that call failed with a temporary error and was retried. One entry per failed attempt. |
| `<item>: sent as a file because Telegram refused it as a photo: <reason>`  | The image was re-sent with `sendDocument`.                                                          |
| `Message: sent as text on its own because the file could not be delivered` | Caption mode: the file failed, so the alert was sent as plain text.                                 |

Example, from a real run with one dropped connection:

```json
{
  "chat_id": "5064323191",
  "success": true,
  "warnings": [
    "Message: attempt 1 failed and was retried: Could not reach Telegram (ECONNRESET); delivery could not be confirmed"
  ]
}
```

### Error responses

Errors that end the whole request use Nest's exception body:

```json
{ "statusCode": 400, "message": ["…"], "error": "Bad Request" }
```

`message` is an **array** for validation-style 400s (DTO, recipient limit, multipart checks) and a **string** for every other status.

| Status | `message`                                                                  | Cause                                                                                                 |
| ------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 400    | array                                                                      | Validation failed; too many recipients or files; empty file; malformed multipart; multer field limits |
| 400    | string                                                                     | Malformed JSON (from Express)                                                                         |
| 403    | `Cross-site requests from web browsers are not allowed`                    | Browser request from another site                                                                     |
| 404    | `Cannot <METHOD> <path>`                                                   | Wrong method or path                                                                                  |
| 413    | `each file must be at most N MB ("<name>" is larger)`                      | Upload over `MAX_ATTACHMENT_SIZE_MB`                                                                  |
| 413    | `request entity too large` (no `error` field)                              | JSON body over 100 KB                                                                                 |
| 415    | `Content-Type must be application/json or multipart/form-data`             | Other body types                                                                                      |
| 429    | `Too many requests, please try again in <wait>`                            | Rate limit; `<wait>` like `42 seconds`, `1 minute`, `1 minute 5 seconds`                              |
| 500    | `Telegram delivery is unavailable because of a server configuration error` | Telegram rejected the bot token (HTTP 401/404 from Telegram)                                          |
| 500    | `Internal server error`                                                    | Any other unexpected exception                                                                        |

### Headers

| Header                                                            | Direction          | Details                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Type`                                                    | request            | `application/json` or `multipart/form-data` (curl/libraries set the boundary)                                                                   |
| `X-Request-Id`                                                    | request (optional) | Kept if it matches `^[\w.-]{1,64}$` (letters, digits, `_`, `.`, `-`); otherwise replaced.                                                       |
| `X-Request-Id`                                                    | response           | The ID used in error-log lines for this request: the caller's ID or a random UUID. Present on all responses except malformed or oversized JSON. |
| `Origin`, `Sec-Fetch-Site`                                        | request            | Used by the cross-site check. Server-side clients don't send them. See [security.md](security.md#cross-site-protection).                        |
| `Retry-After`                                                     | response (429)     | Seconds until the block ends; the 429 message states the same wait in words.                                                                    |
| `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` | response           | Set by `@nestjs/throttler` on throttled routes.                                                                                                 |

`X-Powered-By` is disabled. CORS is not enabled.

### Timing

The response is sent after every delivery finishes. Worst case for **one** Telegram call with the defaults: 4 attempts × 10 s timeout + 1 + 2 + 4 s of backoff ≈ **47 s**. Rate-limit waits can add up to 30 s per retry. A chat makes calls one after another (message plus each file), and chats run 5 at a time, so give callers a generous timeout. curl has none by default.

## Examples

```bash
# JSON, text only
curl -sS http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -d '{"chat_ids":["123456789"],"message":"Disk almost full on web-1"}'

# Multipart with files, two chats in one field
curl -sS http://localhost:3000/api/send \
  -F "chat_ids=123456789,-1001234567890" \
  --form-string "message=High CPU on $(hostname)" \
  -F files=@cpu.png \
  -F files=@top.txt

# Command output from stdin, named
ps aux | curl -sS http://localhost:3000/api/send \
  -F chat_ids=123456789 -F "message=Processes" -F "files=@-;filename=ps.txt"

# Your own request ID, to find the log lines later
curl -sS -i http://localhost:3000/api/send -H "X-Request-Id: cpu-check-web1" \
  -F chat_ids=123456789 -F "message=CPU high"
```

curl notes:

- `-F name=@path` uploads a file and `-F "name=<path"` reads a text value from a file. A value that starts with `@` or `<` is therefore special. Use `--form-string` for text that may start with those characters, e.g. messages from variables.
- Windows: use `curl.exe` (in PowerShell, `curl` is `Invoke-WebRequest`). Windows PowerShell 5.1's `Invoke-RestMethod` cannot send multipart forms.

## Client checklist

- Treat **207** as "check each result", not as total failure.
- Log or alert on `warnings` to catch a flaky network before it starts losing alerts.
- After a `delivery could not be confirmed` error, resending may duplicate. The service has already retried.
- Attach only non-empty files within the size limit. One bad file rejects the whole request, alert included. See the README's snapshot recipe and `test/fire.sh` option 8.
- Send `X-Request-Id` (e.g. the check name plus a timestamp) to correlate with the server's error log.
