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
   * Sends `message` to every chat and reports the outcome per chat, in request
   * order. A failed chat never stops delivery to the others.
   */
  async send(chatIds: string[], message: string): Promise<DeliverySummary> {
    if (chatIds.length > this.maxRecipients) {
      // Same body shape as the ValidationPipe's errors.
      throw new BadRequestException([
        `chat_ids must contain at most ${this.maxRecipients} chat IDs`,
      ]);
    }

    const results = await mapWithConcurrency(
      chatIds,
      MAX_CONCURRENT_DELIVERIES,
      (chatId) => this.deliver(chatId, message),
    );
    const sent = results.filter((result) => result.success).length;
    return {
      total: results.length,
      sent,
      failed: results.length - sent,
      results,
    };
  }

  private async deliver(
    chatId: string,
    message: string,
  ): Promise<DeliveryResult> {
    try {
      await this.telegram.sendMessage(chatId, message);
      return { chat_id: chatId, success: true };
    } catch (error) {
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
        this.logger.warn(`Delivery to chat ${chatId} failed: ${error.message}`);
        return { chat_id: chatId, success: false, error: error.message };
      }
      this.logger.error(
        `Unexpected error while delivering to chat ${chatId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return {
        chat_id: chatId,
        success: false,
        error: 'Unexpected error while sending the message',
      };
    }
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
