import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';

const TELEGRAM_API_URL = 'https://api.telegram.org';

/** Rate-limit waits longer than this fail fast instead of holding the HTTP request open. */
const MAX_RETRY_AFTER_SECONDS = 30;

/** Wait before the first retry; it doubles for each further retry. */
const RETRY_BASE_DELAY_MS = 1_000;

export type TelegramFailureReason =
  // The bot token was rejected: a server configuration problem.
  | 'unauthorized'
  // Telegram refused this message, e.g. unknown chat or bot blocked by the user.
  | 'rejected'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'invalid_response';

/** A failed Bot API call. The message is safe to return to API clients. */
export class TelegramApiError extends Error {
  constructor(
    readonly reason: TelegramFailureReason,
    message: string,
    readonly retryAfterSeconds?: number,
    /** Why the earlier attempts failed, if this failure followed retries. */
    readonly failedAttempts: readonly string[] = [],
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/** A delivered message or file. */
export interface SendResult {
  messageId: number | undefined;
  /** Why the attempts before the successful one failed, if any. */
  failedAttempts: string[];
}

/** A file to upload. */
export interface TelegramFile {
  filename: string;
  content: Blob;
}

export interface SendFileOptions {
  /** Text shown under the file. */
  caption?: string;
  /** Sends the file as a reply to this message. */
  replyToMessageId?: number;
  /** Delivers the file without a notification sound. */
  silent?: boolean;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id?: unknown };
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const token = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    this.botUrl = `${TELEGRAM_API_URL}/bot${token}`;
    this.timeoutMs = config.get('TELEGRAM_REQUEST_TIMEOUT_MS', { infer: true });
    this.maxRetries = config.get('TELEGRAM_MAX_RETRIES', { infer: true });
  }

  /**
   * Sends a plain-text message. Resolves with the new message's ID once
   * Telegram confirms delivery, along with any attempts that failed first,
   * and throws a TelegramApiError otherwise.
   */
  sendMessage(chatId: string, text: string): Promise<SendResult> {
    return this.call('sendMessage', JSON.stringify({ chat_id: chatId, text }));
  }

  /**
   * Uploads an image that Telegram shows inline, after compressing it. Same
   * outcome contract as sendMessage.
   */
  sendPhoto(
    chatId: string,
    file: TelegramFile,
    options: SendFileOptions = {},
  ): Promise<SendResult> {
    return this.call('sendPhoto', fileForm(chatId, 'photo', file, options));
  }

  /** Uploads a file unchanged. Same outcome contract as sendMessage. */
  sendDocument(
    chatId: string,
    file: TelegramFile,
    options: SendFileOptions = {},
  ): Promise<SendResult> {
    return this.call(
      'sendDocument',
      fileForm(chatId, 'document', file, options),
    );
  }

  /**
   * Posts to the Bot API, retrying transient failures up to maxRetries times.
   *
   * After a timeout or a dropped connection the message may already have
   * been delivered, so a retry can send it twice. For alerts a duplicate is
   * better than a lost message. Refusals are final and never retried.
   */
  private async call(
    method: string,
    body: string | FormData,
  ): Promise<SendResult> {
    const failedAttempts: string[] = [];
    for (let attempt = 1; ; attempt++) {
      try {
        return { messageId: await this.post(method, body), failedAttempts };
      } catch (error) {
        const delayMs =
          attempt <= this.maxRetries ? retryDelayMs(error, attempt) : undefined;
        if (delayMs === undefined) {
          throw attempt > 1 ? withAttempts(error, failedAttempts) : error;
        }
        failedAttempts.push((error as Error).message);
        this.logger.warn(
          `${method} failed (${(error as Error).message}); retry ${attempt} of ${this.maxRetries} in ${delayMs} ms`,
        );
        await sleep(delayMs);
      }
    }
  }

  private async post(
    method: string,
    body: string | FormData,
  ): Promise<number | undefined> {
    let response: Response;
    let rawBody: string;
    try {
      response = await fetch(`${this.botUrl}/${method}`, {
        method: 'POST',
        // For FormData, fetch sets the multipart Content-Type and boundary.
        headers:
          typeof body === 'string'
            ? { 'Content-Type': 'application/json' }
            : undefined,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      rawBody = await response.text();
    } catch (error) {
      throw this.toTransportError(error);
    }

    const parsed = parseTelegramResponse(rawBody);
    if (response.ok && parsed?.ok) {
      const messageId = parsed.result?.message_id;
      return typeof messageId === 'number' ? messageId : undefined;
    }
    throw toApiError(response.status, parsed);
  }

  private toTransportError(error: unknown): TelegramApiError {
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      return new TelegramApiError(
        'timeout',
        `Telegram did not respond within ${this.timeoutMs} ms; delivery could not be confirmed`,
      );
    }
    // Only the error code is used: fetch error messages can contain the
    // request URL, and the URL contains the bot token.
    const code = errorCode(error);
    this.logger.warn(`Request to Telegram failed: ${code ?? 'unknown error'}`);
    return new TelegramApiError(
      'network_error',
      `Could not reach Telegram${code === undefined ? '' : ` (${code})`}; delivery could not be confirmed`,
    );
  }
}

function fileForm(
  chatId: string,
  field: 'photo' | 'document',
  file: TelegramFile,
  options: SendFileOptions,
): FormData {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append(field, file.content, file.filename);
  if (options.caption !== undefined) {
    form.append('caption', options.caption);
  }
  if (options.replyToMessageId !== undefined) {
    // If the message is gone by now, the file is still sent, just not as a reply.
    form.append(
      'reply_parameters',
      JSON.stringify({
        message_id: options.replyToMessageId,
        allow_sending_without_reply: true,
      }),
    );
  }
  if (options.silent) {
    form.append('disable_notification', 'true');
  }
  return form;
}

function toApiError(
  httpStatus: number,
  body: TelegramApiResponse | undefined,
): TelegramApiError {
  const code = body?.error_code ?? httpStatus;

  // Telegram answers 401 for a wrong or revoked token and 404 for a malformed one.
  if (code === 401 || code === 404) {
    return new TelegramApiError(
      'unauthorized',
      'Telegram rejected the bot token',
    );
  }
  if (code === 429) {
    const retryAfter = body?.parameters?.retry_after;
    return typeof retryAfter === 'number'
      ? new TelegramApiError(
          'rate_limited',
          `Rate limited by Telegram; retry after ${retryAfter} seconds`,
          retryAfter,
        )
      : new TelegramApiError(
          'rate_limited',
          'Rate limited by Telegram; try again later',
        );
  }
  if (code >= 500) {
    return new TelegramApiError(
      'server_error',
      `Telegram server error (HTTP ${httpStatus}); delivery could not be confirmed`,
    );
  }
  if (!body?.description) {
    return new TelegramApiError(
      'invalid_response',
      `Unexpected response from Telegram (HTTP ${httpStatus}); delivery could not be confirmed`,
    );
  }

  const migratedTo = body.parameters?.migrate_to_chat_id;
  const hint =
    migratedTo === undefined ? '' : ` (the group is now chat ID ${migratedTo})`;
  return new TelegramApiError(
    'rejected',
    `Telegram API error ${code}: ${body.description}${hint}`,
  );
}

/** How long to wait before retrying after `error`, or undefined if it is final. */
function retryDelayMs(error: unknown, attempt: number): number | undefined {
  if (!(error instanceof TelegramApiError)) {
    return undefined;
  }
  switch (error.reason) {
    case 'rate_limited':
      if (error.retryAfterSeconds === undefined) {
        break;
      }
      // Telegram did not send the message and says when to try again.
      return error.retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
        ? error.retryAfterSeconds * 1000
        : undefined;
    case 'timeout':
    case 'network_error':
    case 'server_error':
    case 'invalid_response':
      break;
    default:
      // Refused or unauthorized: retrying would fail the same way.
      return undefined;
  }
  return RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

/** Notes in the message that the final failure followed retries. */
function withAttempts(
  error: unknown,
  failedAttempts: readonly string[],
): unknown {
  return error instanceof TelegramApiError
    ? new TelegramApiError(
        error.reason,
        `${error.message} (after ${failedAttempts.length + 1} attempts)`,
        error.retryAfterSeconds,
        failedAttempts,
      )
    : error;
}

function parseTelegramResponse(raw: string): TelegramApiResponse | undefined {
  try {
    const body: unknown = JSON.parse(raw);
    return typeof body === 'object' &&
      body !== null &&
      typeof (body as TelegramApiResponse).ok === 'boolean'
      ? (body as TelegramApiResponse)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The system or undici error code, such as ECONNRESET, if there is one. */
function errorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
