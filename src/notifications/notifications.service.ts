import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  type SendFileOptions,
  TelegramApiError,
  TelegramService,
} from '../telegram/telegram.service.js';
import type { Attachment } from './attachment.js';

/** Upper bound on simultaneous Telegram requests for a single API call. */
const MAX_CONCURRENT_DELIVERIES = 5;

/** Telegram's limit for a caption, in UTF-16 code units like the message. */
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

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
   * Sends a single attachment with the message as its caption when the
   * message fits. Otherwise sends the message, then each attachment in order,
   * and stops at the first failure: everything before the failed item was
   * delivered.
   */
  private async deliver(
    chatId: string,
    message: string,
    attachments: readonly Attachment[],
  ): Promise<DeliveryResult> {
    if (
      attachments.length === 1 &&
      message.length <= TELEGRAM_MAX_CAPTION_LENGTH
    ) {
      return this.deliverCaptioned(chatId, message, attachments[0]);
    }

    let messageId: number | undefined;
    try {
      messageId = await this.telegram.sendMessage(chatId, message);
    } catch (error) {
      return this.failure(chatId, error);
    }

    // Silent replies keep the files next to their alert in a busy chat, and
    // each alert notifies only once.
    const options = { replyToMessageId: messageId, silent: true };
    for (const [index, attachment] of attachments.entries()) {
      try {
        await this.sendAttachment(chatId, attachment, options);
      } catch (error) {
        return this.failure(chatId, error, attachmentLabel(index, attachment));
      }
    }
    return { chat_id: chatId, success: true };
  }

  /** Sends one attachment captioned with the message, as a single post. */
  private async deliverCaptioned(
    chatId: string,
    message: string,
    attachment: Attachment,
  ): Promise<DeliveryResult> {
    try {
      await this.sendAttachment(chatId, attachment, { caption: message });
      return { chat_id: chatId, success: true };
    } catch (error) {
      if (!isRefusal(error)) {
        return this.failure(chatId, error, attachmentLabel(0, attachment));
      }
      // Nothing was sent, so the alert itself can still go out as text.
      try {
        await this.telegram.sendMessage(chatId, message);
      } catch (messageError) {
        return this.failure(chatId, messageError);
      }
      return this.failure(chatId, error, attachmentLabel(0, attachment));
    }
  }

  private async sendAttachment(
    chatId: string,
    attachment: Attachment,
    options: SendFileOptions,
  ): Promise<void> {
    if (attachment.isPhoto) {
      try {
        await this.telegram.sendPhoto(chatId, attachment, options);
        return;
      } catch (error) {
        // A refusal means nothing was sent, so the image can safely go out as
        // a file instead, for example when its aspect ratio is too extreme.
        if (isRefusal(error)) {
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

/** Telegram refused the request, so nothing was sent and a retry is safe. */
function isRefusal(error: unknown): error is TelegramApiError {
  return error instanceof TelegramApiError && error.reason === 'rejected';
}

function attachmentLabel(index: number, attachment: Attachment): string {
  return `Attachment ${index + 1} ("${attachment.filename}")`;
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
