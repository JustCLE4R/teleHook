import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  TelegramApiError,
  TelegramService,
} from '../telegram/telegram.service.js';
import type { Attachment } from './attachment.js';

/** Upper bound on simultaneous Telegram requests for a single API call. */
const MAX_CONCURRENT_DELIVERIES = 5;

export interface DeliveryResult {
  chat_id: string;
  success: boolean;
  error?: string;
}

export interface DeliverySummary {
  total: number;
  sent: number;
  failed: number;
  results: DeliveryResult[];
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly maxRecipients: number;

  constructor(
    private readonly telegram: TelegramService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.maxRecipients = config.get('MAX_RECIPIENTS_PER_REQUEST', {
      infer: true,
    });
  }

  /**
   * Sends `message`, followed by any attachments, to every chat and reports
   * the outcome per chat, in request order. A failed chat never stops
   * delivery to the others.
   */
  async send(
    chatIds: string[],
    message: string,
    attachments: readonly Attachment[] = [],
  ): Promise<DeliverySummary> {
    if (chatIds.length > this.maxRecipients) {
      // Same body shape as the ValidationPipe's errors.
      throw new BadRequestException([
        `chat_ids must contain at most ${this.maxRecipients} chat IDs`,
      ]);
    }

    const results = await mapWithConcurrency(
      chatIds,
      MAX_CONCURRENT_DELIVERIES,
      (chatId) => this.deliver(chatId, message, attachments),
    );
    const sent = results.filter((result) => result.success).length;
    return {
      total: results.length,
      sent,
      failed: results.length - sent,
      results,
    };
  }

  /**
   * Sends the message, then each attachment in order, and stops at the first
   * failure: everything before the failed item was delivered.
   */
  private async deliver(
    chatId: string,
    message: string,
    attachments: readonly Attachment[],
  ): Promise<DeliveryResult> {
    let messageId: number | undefined;
    try {
      messageId = await this.telegram.sendMessage(chatId, message);
    } catch (error) {
      return this.failure(chatId, error);
    }

    for (const [index, attachment] of attachments.entries()) {
      try {
        await this.sendAttachment(chatId, attachment, messageId);
      } catch (error) {
        return this.failure(
          chatId,
          error,
          `Attachment ${index + 1} ("${attachment.filename}")`,
        );
      }
    }
    return { chat_id: chatId, success: true };
  }

  /**
   * Sends the attachment as a silent reply to the message, so it stays next
   * to its alert in a busy chat and each alert notifies only once.
   */
  private async sendAttachment(
    chatId: string,
    attachment: Attachment,
    replyToMessageId: number | undefined,
  ): Promise<void> {
    const options = { replyToMessageId, silent: true };
    if (attachment.isPhoto) {
      try {
        await this.telegram.sendPhoto(chatId, attachment, {
          ...options,
          // Photos, unlike files, show no name.
          caption: attachment.filename,
        });
        return;
      } catch (error) {
        // A refusal means nothing was sent, so the image can safely go out as
        // a file instead, for example when its aspect ratio is too extreme.
        if (error instanceof TelegramApiError && error.reason === 'rejected') {
          this.logger.warn(
            `Telegram refused "${attachment.filename}" as a photo for chat ${chatId}; sending it as a file: ${error.message}`,
          );
        } else {
          throw error;
        }
      }
    }
    await this.telegram.sendDocument(chatId, attachment, options);
  }

  /** `item` names the attachment that failed, if it was not the message. */
  private failure(
    chatId: string,
    error: unknown,
    item?: string,
  ): DeliveryResult {
    if (error instanceof TelegramApiError) {
      if (error.reason === 'unauthorized') {
        // Not a per-chat failure: every delivery would fail the same way.
        this.logger.error(
          'Telegram rejected the bot token; check TELEGRAM_BOT_TOKEN',
        );
        throw new InternalServerErrorException(
          'Telegram delivery is unavailable because of a server configuration error',
        );
      }
      const reason =
        item === undefined ? error.message : `${item}: ${error.message}`;
      this.logger.warn(`Delivery to chat ${chatId} failed: ${reason}`);
      return { chat_id: chatId, success: false, error: reason };
    }
    this.logger.error(
      `Unexpected error while delivering to chat ${chatId}`,
      error instanceof Error ? error.stack : String(error),
    );
    return {
      chat_id: chatId,
      success: false,
      error:
        item === undefined
          ? 'Unexpected error while sending the message'
          : `${item}: Unexpected error while sending the file`,
    };
  }
}

/**
 * Maps `items` through `task` with at most `limit` tasks in flight, keeping
 * input order. If a task throws, no further tasks start and the error is
 * rethrown.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  let aborted = false;

  const worker = async (): Promise<void> => {
    while (!aborted && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await task(items[index]);
      } catch (error) {
        aborted = true;
        throw error;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
