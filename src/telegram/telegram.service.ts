import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';

const TELEGRAM_API_URL = 'https://api.telegram.org';

/** Rate-limit waits longer than this fail fast instead of holding the HTTP request open. */
const MAX_RETRY_AFTER_SECONDS = 5;

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

/** A failed sendMessage call. The message is safe to return to API clients. */
export class TelegramApiError extends Error {
  constructor(
    readonly reason: TelegramFailureReason,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

interface TelegramApiResponse {
  ok: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly sendMessageUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const token = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    this.sendMessageUrl = `${TELEGRAM_API_URL}/bot${token}/sendMessage`;
    this.timeoutMs = config.get('TELEGRAM_REQUEST_TIMEOUT_MS', { infer: true });
  }

  /**
   * Sends a plain-text message. Resolves once Telegram confirms delivery and
   * throws a TelegramApiError otherwise.
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.postSendMessage(chatId, text);
    } catch (error) {
      const retryAfter = retryableDelaySeconds(error);
      if (retryAfter === undefined) {
        throw error;
      }
      // HTTP 429 means Telegram did not send the message, so a single delayed
      // retry cannot create a duplicate. Nothing else is retried: after a
      // timeout or network error the message may already have been delivered.
      await sleep(retryAfter * 1000);
      await this.postSendMessage(chatId, text);
    }
  }

  private async postSendMessage(chatId: string, text: string): Promise<void> {
    let response: Response;
    let rawBody: string;
    try {
      response = await fetch(this.sendMessageUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      rawBody = await response.text();
    } catch (error) {
      throw this.toTransportError(error);
    }

    const body = parseTelegramResponse(rawBody);
    if (response.ok && body?.ok) {
      return;
    }
    throw toApiError(response.status, body);
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
    // Log only the error code: fetch error messages can contain the request
    // URL, and the URL contains the bot token.
    this.logger.warn(`Request to Telegram failed: ${errorCode(error)}`);
    return new TelegramApiError(
      'network_error',
      'Could not reach Telegram; delivery could not be confirmed',
    );
  }
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

function retryableDelaySeconds(error: unknown): number | undefined {
  if (
    error instanceof TelegramApiError &&
    error.reason === 'rate_limited' &&
    error.retryAfterSeconds !== undefined &&
    error.retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
  ) {
    return error.retryAfterSeconds;
  }
  return undefined;
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

function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  if (typeof cause?.code === 'string') {
    return cause.code;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
