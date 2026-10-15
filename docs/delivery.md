# Delivery

How `NotificationsService` (`src/notifications/notifications.service.ts`) turns one validated request into Telegram messages, and how it reports the outcome. The Bot API client underneath (retries, error classes) is in [telegram-client.md](telegram-client.md).

## Guiding rules

In priority order:

1. **The alert text must get through.** A problem with a file never stops the message from being attempted.
2. **Report precisely what happened.** Per chat: success or the first failure, plus warnings for every problem that was worked around.
3. **Prefer a duplicate over a lost alert.** Retries happen even when the first attempt may have been delivered.
4. **Never send something twice when it is known to have failed safely.** A refusal is retried only in a _different form_ (photo → document, file → text), never as-is.

## Entry point

```ts
NotificationsService.send(chatIds: string[], message: string, attachments: readonly Attachment[] = []): Promise<DeliverySummary>
```

1. If `chatIds.length > MAX_RECIPIENTS_PER_REQUEST`: throw `BadRequestException(['chat_ids must contain at most N chat IDs'])` before sending anything.
2. Deliver to every chat through `mapWithConcurrency(chatIds, 5, …)`. Each chat gets a fresh `Warnings` collector and runs `deliver()`.
3. Attach `warnings` to a chat's result only if the list is non-empty.
4. Return `{ total, sent, failed, results }`, with `results` in request order.

## Choosing the mode, per chat

```text
deliver(chatId, message, attachments):
  if attachments.length === 1 and message.length <= 1024:   → caption mode
  else:                                                      → reply mode (includes text-only: 0 attachments)
```

`message.length` is in UTF-16 code units, matching Telegram's caption limit (1024) and the DTO's message limit (4096).

### Text only (0 attachments)

One `sendMessage`. The result is success, or the failure with the message's reason.

### Caption mode

Exactly one attachment and a message that fits in a caption. The goal is **one post**: the file with the alert as its caption.

```text
deliverCaptioned:
  sendAttachment(file, { caption: message })          ← photo or document, with fallback (see below)
  success                                             → { success: true }
  failure:
    record the attempts that failed before it as warnings (if retried)
    if reason is 'unauthorized'                       → 500 for the whole request
    otherwise send the message as plain text:         ← the alert must get through
      text OK   → warning "Message: sent as text on its own because the file could not be delivered"
                  result: { success: false, error: 'Attachment 1 ("name"): <file reason>' }
      text fails→ result: { success: false, error: '<message reason>' }   (the message's own error)
```

Notes:

- No `reply_parameters` and no `disable_notification` in caption mode. The single post is the alert, so it notifies normally.
- **The text fallback runs for any failure except a bad token,** including timeouts and network errors where the captioned file _may_ have arrived. A duplicate alert is accepted (rule 3).
- When the fallback succeeds, the chat still counts as **failed**, because the file did not arrive. The error names the attachment, and a warning says the text went out. So `error: 'Attachment 1 (…)'` together with that warning means _the alert arrived as text, the file did not_.
- When the fallback also fails, the error is the **message's** reason, not the file's, and warnings list the retries of both.

### Reply mode

Several attachments, or one attachment with a message longer than 1024 units.

```text
sendMessage(message)
  failure → record retries as warnings; result = failure(message reason); STOP (no files attempted)
  success → messageId (may be undefined if Telegram omitted it)
for each attachment, in upload order:
  sendAttachment(file, { replyToMessageId: messageId, silent: true })
  failure → record retries as warnings; result = failure('Attachment N ("name"): <reason>'); STOP
success → { success: true }
```

- Every file is a **reply** to the alert (`reply_parameters: { message_id, allow_sending_without_reply: true }`). In a busy chat where several alerts arrive at once, each alert's files stay visibly attached to it. If the message is gone, the file is still sent, just not as a reply.
- Every file is **silent** (`disable_notification: true`). Each alert notifies once, not once per file.
- **No captions** on files in reply mode. Photos show no text, and documents show their file name.
- If `sendMessage` returned no `message_id` (unexpected), files are sent without `reply_parameters`.
- **Stop at the first failure.** Everything before the failed item was delivered, and nothing after it was attempted. The error's `Attachment N` tells the caller where it stopped.

## Photo or document

`toAttachment()` (`src/notifications/attachment.ts`) decides once per upload:

```text
isPhoto = size <= 10 MiB (10 × 1024 × 1024 bytes)
          and the file starts with a JPEG (FF D8 FF) or PNG (89 50 4E 47 0D 0A 1A 0A) signature
```

- Detection uses **content**, not the file name or the client's MIME type. A `fake.png` containing text is a document; a JPEG named `shot.bin` is a photo.
- GIF, WebP, BMP, PDF and everything else are documents. Telegram's handling of those formats as photos is unreliable, and documents always work.
- Images over 10 MiB are documents, since Telegram's photo limit is 10 MB.

`sendAttachment()` then does:

```text
if isPhoto:
  try sendPhoto(options)
  on 'rejected' (Telegram refused the image, e.g. PHOTO_INVALID_DIMENSIONS for a very tall screenshot):
      log a warning, record its retries, add warning
      "<item>: sent as a file because Telegram refused it as a photo: <reason>"
      fall through to sendDocument with the SAME options (caption, reply, silent)
  on any other failure: rethrow (no fallback: the photo may have been delivered)
sendDocument(options)
```

The photo → document fallback is safe because a refusal means nothing was sent.

## Warnings

`Warnings` is a small collector created per chat. Each entry is `<item>: <text>`, where `<item>` is `Message` or `Attachment N ("name")` (`attachmentLabel()`):

| Source                                                                       | Text                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A call that eventually succeeded after retries (`SendResult.failedAttempts`) | `attempt K failed and was retried: <reason>`, one entry per failed attempt                             |
| A call that failed after retries (`TelegramApiError.failedAttempts`)         | Same, for the attempts before the final one. The final reason is in `error` with `(after N attempts)`. |
| Photo refused, sent as a document                                            | `sent as a file because Telegram refused it as a photo: <reason>`                                      |
| Caption mode text fallback succeeded                                         | `Message: sent as text on its own because the file could not be delivered`                             |

A reason can carry its own attempt count. For example, a photo refused on its second attempt (after a dropped connection) produces, in order:

```text
Attachment 1 ("shot.png"): attempt 1 failed and was retried: Could not reach Telegram (ECONNRESET); delivery could not be confirmed
Attachment 1 ("shot.png"): sent as a file because Telegram refused it as a photo: Telegram API error 400: Bad Request: PHOTO_INVALID_DIMENSIONS (after 2 attempts)
```

Warnings are chronological within a chat. They never change `success` or the HTTP status: a chat with warnings and no error is a success (200).

## Failure handling (`failure()`)

| Error                                         | Effect                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TelegramApiError` with reason `unauthorized` | Logs `Telegram rejected the bot token; check TELEGRAM_BOT_TOKEN` (error), throws `InternalServerErrorException('Telegram delivery is unavailable because of a server configuration error')`. The whole request becomes 500, and no further chats start.                    |
| Any other `TelegramApiError`                  | Result `{ success: false, error: [item + ': '] + error.message }`. Logs `Delivery to chat <id> failed: <reason>` (warn).                                                                                                                                                   |
| Anything else (a bug)                         | Result `{ success: false, error: 'Unexpected error while sending the message' }` or `'Attachment N ("name"): Unexpected error while sending the file'`. Logs `Unexpected error while delivering to chat <id>` with the stack (error). Internal details are never returned. |

## Concurrency and ordering

- Up to **5 chats** are delivered at once (`MAX_CONCURRENT_DELIVERIES`). Results keep request order regardless of completion order.
- Within a chat, calls are sequential: message → file 1 → file 2 …
- Telegram's own limits (roughly 1 message/second per chat, 20/minute per group, 30/second overall) can produce 429s on bursts. The client honours `retry_after` up to 30 s. See [telegram-client.md](telegram-client.md#retry-policy).
- A request with `C` chats and `F` files makes about `C × (1 + F)` Bot API calls, plus retries and fallbacks. Each file is uploaded separately to each chat.

## Worked examples

**1. Two files, one chat, all fine.**
Calls: `sendMessage` → `sendPhoto(reply, silent)` → `sendDocument(reply, silent)`. Result `{ chat_id, success: true }`.

**2. One PNG, short message.**
Calls: `sendPhoto(caption=message)`. Result `{ success: true }`. No reply, not silent.

**3. One PNG, Telegram refuses it as a photo.**
Calls: `sendPhoto(caption)` → 400 PHOTO_INVALID_DIMENSIONS → `sendDocument(caption)`. Result `{ success: true, warnings: ['Attachment 1 ("page.png"): sent as a file because Telegram refused it as a photo: Telegram API error 400: Bad Request: PHOTO_INVALID_DIMENSIONS'] }`.

**4. One file, upload keeps dropping (retries exhausted), text works.**
Calls: `sendDocument` ×4 (with 1 s, 2 s, 4 s waits) → `sendMessage`. Result:

```json
{
  "chat_id": "123",
  "success": false,
  "error": "Attachment 1 (\"top.txt\"): Could not reach Telegram (ECONNRESET); delivery could not be confirmed (after 4 attempts)",
  "warnings": [
    "Attachment 1 (\"top.txt\"): attempt 1 failed and was retried: Could not reach Telegram (ECONNRESET); delivery could not be confirmed",
    "Attachment 1 (\"top.txt\"): attempt 2 failed and was retried: …",
    "Attachment 1 (\"top.txt\"): attempt 3 failed and was retried: …",
    "Message: sent as text on its own because the file could not be delivered"
  ]
}
```

**5. Three files, the second is refused as a document.**
Calls: `sendMessage` → file 1 → file 2 (refused). File 3 is not attempted. Result `{ success: false, error: 'Attachment 2 ("top.txt"): Telegram API error 400: …' }`.

**6. The bot was blocked by the user.**
`sendMessage` → 403 `rejected`, not retried. Result `{ success: false, error: 'Telegram API error 403: Forbidden: bot was blocked by the user' }`. Files are not attempted.

**7. Wrong bot token.**
First call → 401 → `unauthorized` → the whole request returns 500. Chats already in flight may have finished, but their results are discarded.

## Changing delivery behaviour safely

- Keep the per-chat result shape: `chat_id`, `success`, optional `error`, optional `warnings`. Callers parse it.
- If you add a fallback, decide first whether the failed attempt _may_ have been delivered. Fall back automatically only after a refusal, unless the fallback exists to protect the alert text (as caption mode does).
- Add a warning for every problem you work around, and a test in `notifications.service.spec.ts` under `describe('warnings')`.
- Update [api-reference.md](api-reference.md), this file and the top-level README's _Attaching files_ and _Delivery behaviour_ sections.
