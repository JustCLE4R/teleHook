# Design decisions

Why teleHook works the way it does, and which alternatives were rejected. Read the relevant decision before changing related behaviour: most of these were deliberate trade-offs, not accidents. Decisions are listed roughly in the order they were made.

---

## D1. Stateless, unauthenticated, single endpoint

**Decision:** No database, no queue, no stored state, no authentication. Recipients come only from the request, and results exist only in the response.

**Why:** The service is a thin, easy-to-run delivery channel for alerts on a private network. Auth and TLS are left to the network or a reverse proxy.

**Consequences:** Anyone who can reach the port can use the bot (see [security.md](security.md)). Delivery is synchronous: if the server or Telegram is down longer than the retries last, the alert is reported as failed and not kept.

**Revisit if:** the service must be reachable from untrusted networks (add API-key auth), or alerts must survive outages (add a durable outbox; the API would answer 202).

## D2. Strict validation, reject instead of fix

**Decision:** Invalid input is rejected with 400 before anything is sent. Duplicates are rejected, not removed. Unknown fields are rejected. JSON `chat_ids` must be an array.

**Why:** Predictable behaviour and a one-to-one mapping between `chat_ids` and `results`. Mistakes surface while a script is being written, not as silent surprises later.

**Consequences:** One bad attachment (empty, too big, too many) rejects the whole request, alert text included. Scripts must guard their attachments (`[ -s file ]`, `tail`), as the README recipe and `fire.sh` option 8 do.

**Rejected alternative:** silently skipping empty or oversized files. Rejected for consistency with the existing strictness. It is the most likely decision to revisit for alerting reliability.

## D3. Multipart for files, on the same endpoint

**Decision:** Files are uploaded as `multipart/form-data` to `POST /api/send`, in a single field named `files`. JSON stays text-only and unchanged.

**Why:** Shell scripts on servers are the main clients, and `curl -F files=@path` (and stdin with `@-`) is the simplest possible interface. Every HTTP library supports multipart.

**Rejected alternatives:**

- _Base64 in JSON:_ 33% overhead, awkward from shell (jq can't base64 binary files), and needs a bigger JSON body limit.
- _URLs for Telegram to fetch:_ only works for publicly reachable files, while diagnostics usually live on private servers.
- _Server-side file paths:_ would let any caller read arbitrary files from the server (`.env` with the token, for example).
- _Separate `photos` and `files` fields:_ more to learn, and a wrong field would need its own errors. Automatic photo detection (D5) is simpler.

**Details:** multer memory storage, limits enforced while streaming, and `chat_ids` accepted as one field, repeated fields, a comma-separated list or bracket fields (multipart only; JSON stays strict).

## D4. Cross-site check instead of JSON-only

**Decision:** Replace the original "JSON bodies only" rule with an explicit check that rejects cross-site browser requests (`Sec-Fetch-Site`, falling back to `Origin` vs `Host`), and keep a 415 for other content types.

**Why:** The JSON-only rule existed to stop cross-site HTML form posts (CSRF against a service on the visitor's network). Multipart _is_ a form encoding, so allowing it reopened that hole. Checking browser headers protects both formats and is invisible to curl and server-side clients, which send neither header.

**Rejected alternatives:**

- _A required custom header:_ robust, but every caller would have to add it.
- _Authentication:_ out of scope (D1).

## D5. Photos detected by content; documents for everything else

**Decision:** JPEG and PNG files of at most 10 MiB, identified by their leading bytes, are sent with `sendPhoto`. Everything else is sent with `sendDocument`. If Telegram refuses a photo, it is re-sent as a document.

**Why:** Graphs and screenshots read best inline. Logs and reports must arrive unchanged. Client MIME types and file names are unreliable. Telegram's photo handling of GIF/WebP is inconsistent, and documents always work. A refusal (`rejected`) means nothing was sent, so the fallback cannot duplicate anything.

**Consequence:** a dense screenshot is compressed by Telegram. Callers can't force document mode for a JPEG or PNG (possible future option).

## D6. Retry transient failures, accept duplicates

**Decision:** Retry timeouts, network errors (`ECONNRESET` etc.), 5xx and unreadable responses up to `TELEGRAM_MAX_RETRIES` times (default 3) with 1 s/2 s/4 s backoff. Retry 429 after `retry_after` if it is at most 30 s. Never retry refusals or a bad token.

**Why:** Real deployments saw `ECONNRESET` when talking to `api.telegram.org`. The original design never retried delivery-unknown failures, to avoid duplicates, and alerts were lost. For alerting, **a duplicate is better than a lost alert.**

**Consequences:** occasional duplicate messages; one call can take about 47 s in the worst case with defaults; callers need generous timeouts. `TELEGRAM_MAX_RETRIES=0` restores at-most-once behaviour.

**Superseded:** the original single retry, only for 429 with `retry_after` ≤ 5 s.

## D7. Message first, files as silent replies (reply mode)

**Decision:** With several files, or a message too long for a caption: send the message first, then each file as a reply to it (`reply_parameters`, `allow_sending_without_reply: true`) with `disable_notification: true`, without captions. Stop at the first failure.

**Why:**

- Message first means the alert arrives even if an upload fails.
- Replies keep files attached to the right alert when several alerts arrive at once (incident bursts), even if messages interleave.
- Silent files mean one notification per alert, not one per file.
- No captions on files was the user's preference: photos show nothing, documents show their name.
- Stopping at the first failure gives simple, deterministic semantics: "everything before `Attachment N` was delivered".

**Rejected:** media groups (albums). They are all-or-nothing, can't mix photos and documents, and need 2–10 items.

## D8. One file: the message becomes its caption (caption mode)

**Decision:** With exactly one file and a message of at most 1024 UTF-16 units, send a single post: the file with the message as caption, not silent, not a reply. If the file can't be delivered for any reason except a bad token, send the message as text on its own and report the file's error (plus a warning).

**Why:** One tidy post for the most common case (an alert with one graph), as the user requested. The text fallback protects the alert, which would otherwise be lost together with the file.

**Consequence:** when the upload timed out but actually arrived, the text fallback duplicates the alert (accepted, D6). A chat whose text fallback succeeded is still reported as failed, because its file was not delivered.

**Earlier version (superseded):** the message was always sent first, and photos were captioned with their file name.

## D9. Warnings in the response, details in the error log

**Decision:** Each chat result may carry `warnings` (retried attempts, photo sent as file, text fallback). Every warning and error is also written to a daily JSONL error log with request IDs.

**Why:** A recovered problem (e.g. `ECONNRESET` fixed by a retry) was invisible to callers, who saw a plain 200. Warnings let monitoring scripts notice a degrading network before alerts are lost. The log gives operators the full history for analysis.

**Details:** `warnings` is omitted when empty, so normal responses are unchanged. Status and `success` don't change with warnings.

## D10. Error codes, never error messages, from network failures

**Decision:** Network failures are described as `Could not reach Telegram (<CODE>); …`, using only the `cause.code` of the `fetch` error.

**Why:** undici's error messages can include the request URL, which contains the bot token. The code (`ECONNRESET`, `ETIMEDOUT`, `UND_ERR_SOCKET`) is safe and is the most useful diagnostic anyway.

## D11. Request IDs via AsyncLocalStorage

**Decision:** Middleware assigns a request ID (caller's `X-Request-Id` if it matches `^[\w.-]{1,64}$`, else a UUID), returns it in the response header, and makes it available to the logger through `AsyncLocalStorage`.

**Why:** One alert can produce many log lines across retries and concurrent chats. Grouping them needs an ID that follows async work without passing it through every function. Accepting the caller's ID links the server log to the caller's own logs, and the pattern prevents log forging.

**Known gap:** bodies rejected by Express's JSON parser fail before the middleware and have no ID.

## D12. 429 message with the wait in words

**Decision:** The rate-limit message states the wait (`Too many requests, please try again in 1 minute 25 seconds`), computed from the same value as `Retry-After`.

**Why:** Humans running scripts see how long to wait, without reading headers. Machines keep using `Retry-After`.

## D13. Feature folders, no `common/`

**Decision:** Code lives in folders per concern (`config`, `rate-limit`, `logging`, `telegram`, `notifications`). Rate limiting got its own module rather than living in `AppModule` or a `common/` helpers folder.

**Why:** Each helper belongs to the feature that uses it. A `common/` folder tends to collect unrelated code over time.

## D14. Tests can never send real messages

**Decision:** A shared test setup replaces `fetch` with a function that rejects. Each test mocks `fetch` explicitly. The e2e suite pins its own configuration.

**Why:** A test run must never message real chats, whatever is in a developer's `.env`. Manual end-to-end checks use `test/fire.sh` against a fake Telegram (see [testing.md](testing.md#verifying-against-a-fake-telegram)) or, deliberately, the real one.
