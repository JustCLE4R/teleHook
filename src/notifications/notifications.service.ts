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

/** How warnings and errors refer to the message. */
const MESSAGE = 'Message';

export interface DeliveryResult {
  chat_id: string;
  success: boolean;
  error?: string;
  /**
   * Problems that did not stop delivery on their own, such as a retried
   * attempt or a photo sent as a file. Present only when there were any.
   */
  warnings?: string[];
}

export interface DeliverySummary {
  total: number;
  sent: number;
  failed: number;
  results: DeliveryResult[];
}

/** The warnings collected while delivering to one chat. */
class Warnings {
  readonly list: string[] = [];

  add(item: string, text: string): void {
    this.list.push(`${item}: ${text}`);
  }

  /** Records attempts that failed before a later one, by their reasons. */
  retried(item: string, failedAttempts: readonly string[]): void {
    for (const [index, reason] of failedAttempts.entries()) {
      this.add(item, `attempt ${index + 1} failed and was retried: ${reason}`);
    }
  }

  /** Records the attempts before a final failure, which its error counts. */
  retriedBefore(item: string, error: unknown): void {
    if (error instanceof TelegramApiError) {
      this.retried(item, error.failedAttempts);
    }
  }
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
      async (chatId) => {
        const warnings = new Warnings();
        const result = await this.deliver(
          chatId,
          message,
          attachments,
          warnings,
        );
        return warnings.list.length === 0
          ? result
          : { ...result, warnings: warnings.list };
      },
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
    warnings: Warnings,
  ): Promise<DeliveryResult> {
    if (
      attachments.length === 1 &&
      message.length <= TELEGRAM_MAX_CAPTION_LENGTH
    ) {
      return this.deliverCaptioned(chatId, message, attachments[0], warnings);
    }

    let messageId: number | undefined;
    try {
      const sent = await this.telegram.sendMessage(chatId, message);
      warnings.retried(MESSAGE, sent.failedAttempts);
      messageId = sent.messageId;
    } catch (error) {
      warnings.retriedBefore(MESSAGE, error);
      return this.failure(chatId, error);
    }

    // Silent replies keep the files next to their alert in a busy chat, and
    // each alert notifies only once.
    const options = { replyToMessageId: messageId, silent: true };
    for (const [index, attachment] of attachments.entries()) {
      const item = attachmentLabel(index, attachment);
      try {
        await this.sendAttachment(chatId, attachment, options, item, warnings);
      } catch (error) {
        warnings.retriedBefore(item, error);
        return this.failure(chatId, error, item);
      }
    }
    return { chat_id: chatId, success: true };
  }

  /** Sends one attachment captioned with the message, as a single post. */
  private async deliverCaptioned(
    chatId: string,
    message: string,
    attachment: Attachment,
    warnings: Warnings,
  ): Promise<DeliveryResult> {
    const item = attachmentLabel(0, attachment);
    try {
      await this.sendAttachment(
        chatId,
        attachment,
        { caption: message },
        item,
        warnings,
      );
      return { chat_id: chatId, success: true };
    } catch (error) {
      warnings.retriedBefore(item, error);
      if (
        error instanceof TelegramApiError &&
        error.reason === 'unauthorized'
      ) {
        return this.failure(chatId, error, item);
      }
      // The alert must get through, so send it as text on its own. If the
      // upload timed out, the captioned file may have arrived after all; a
      // duplicate alert is better than a lost one.
      try {
        const sent = await this.telegram.sendMessage(chatId, message);
        warnings.retried(MESSAGE, sent.failedAttempts);
        warnings.add(
          MESSAGE,
          'sent as text on its own because the file could not be delivered',
        );
      } catch (messageError) {
        warnings.retriedBefore(MESSAGE, messageError);
        return this.failure(chatId, messageError);
      }
      return this.failure(chatId, error, item);
    }
  }

  private async sendAttachment(
    chatId: string,
    attachment: Attachment,
    options: SendFileOptions,
    item: string,
    warnings: Warnings,
  ): Promise<void> {
    if (attachment.isPhoto) {
      try {
        const sent = await this.telegram.sendPhoto(chatId, attachment, options);
        warnings.retried(item, sent.failedAttempts);
        return;
      } catch (error) {
        // A refusal means nothing was sent, so the image can safely go out as
        // a file instead, for example when its aspect ratio is too extreme.
        if (!isRefusal(error)) {
          throw error;
        }
        this.logger.warn(
          `Telegram refused "${attachment.filename}" as a photo for chat ${chatId}; sending it as a file: ${error.message}`,
        );
        warnings.retriedBefore(item, error);
        warnings.add(
          item,
          `sent as a file because Telegram refused it as a photo: ${error.message}`,
        );
      }
    }
    const sent = await this.telegram.sendDocument(chatId, attachment, options);
    warnings.retried(item, sent.failedAttempts);
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
