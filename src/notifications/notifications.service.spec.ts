import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Mock } from 'vitest';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  TelegramApiError,
  type TelegramService,
} from '../telegram/telegram.service.js';
import { NotificationsService } from './notifications.service.js';

function chatIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => String(100_000 + i));
}

describe('NotificationsService', () => {
  let sendMessage: Mock<TelegramService['sendMessage']>;
  let service: NotificationsService;

  function createService(maxRecipients = 20): NotificationsService {
    const config = { get: () => maxRecipients };
    return new NotificationsService(
      { sendMessage } as unknown as TelegramService,
      config as unknown as ConfigService<EnvironmentVariables, true>,
    );
  }

  beforeEach(() => {
    sendMessage = vi
      .fn<TelegramService['sendMessage']>()
      .mockResolvedValue(undefined);
    service = createService();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('delivers to a single chat', async () => {
    await expect(service.send(['123456789'], 'Hello')).resolves.toEqual({
      total: 1,
      sent: 1,
      failed: 0,
      results: [{ chat_id: '123456789', success: true }],
    });
    expect(sendMessage).toHaveBeenCalledWith('123456789', 'Hello');
  });

  it('delivers to multiple chats and reports results in request order', async () => {
    // The first chat finishes last, so completion order differs from request order.
    sendMessage.mockImplementation(
      (chatId) =>
        new Promise((resolve) => setTimeout(resolve, chatId === '1' ? 20 : 1)),
    );

    await expect(
      service.send(['1', '2', '-1001234567890'], 'Hello'),
    ).resolves.toEqual({
      total: 3,
      sent: 3,
      failed: 0,
      results: [
        { chat_id: '1', success: true },
        { chat_id: '2', success: true },
        { chat_id: '-1001234567890', success: true },
      ],
    });
  });

  it('keeps delivering after a failure and reports each outcome', async () => {
    sendMessage.mockImplementation(async (chatId) => {
      if (chatId === '2') {
        throw new TelegramApiError(
          'rejected',
          'Telegram API error 403: Forbidden: bot was blocked by the user',
        );
      }
    });

    await expect(service.send(['1', '2', '3'], 'Hello')).resolves.toEqual({
      total: 3,
      sent: 2,
      failed: 1,
      results: [
        { chat_id: '1', success: true },
        {
          chat_id: '2',
          success: false,
          error:
            'Telegram API error 403: Forbidden: bot was blocked by the user',
        },
        { chat_id: '3', success: true },
      ],
    });
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it.each([
    new TelegramApiError(
      'timeout',
      'Telegram did not respond within 10000 ms; delivery could not be confirmed',
    ),
    new TelegramApiError(
      'network_error',
      'Could not reach Telegram; delivery could not be confirmed',
    ),
    new TelegramApiError(
      'rate_limited',
      'Rate limited by Telegram; retry after 30 seconds',
      30,
    ),
  ])('reports $reason failures for each chat', async (error) => {
    sendMessage.mockRejectedValue(error);

    await expect(service.send(['1', '2'], 'Hello')).resolves.toEqual({
      total: 2,
      sent: 0,
      failed: 2,
      results: [
        { chat_id: '1', success: false, error: error.message },
        { chat_id: '2', success: false, error: error.message },
      ],
    });
  });

  it('hides unexpected errors behind a generic message', async () => {
    sendMessage.mockRejectedValue(new Error('internal detail'));

    await expect(service.send(['1'], 'Hello')).resolves.toMatchObject({
      results: [
        {
          chat_id: '1',
          success: false,
          error: 'Unexpected error while sending the message',
        },
      ],
    });
  });

  it('rejects more recipients than the configured maximum without sending', async () => {
    service = createService(3);

    const error: unknown = await service
      .send(chatIds(4), 'Hello')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      message: ['chat_ids must contain at most 3 chat IDs'],
    });
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(service.send(chatIds(3), 'Hello')).resolves.toMatchObject({
      sent: 3,
    });
  });

  it('sends to at most 5 chats at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    sendMessage.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });

    await expect(service.send(chatIds(12), 'Hello')).resolves.toMatchObject({
      sent: 12,
    });
    expect(maxInFlight).toBe(5);
  });

  it('stops and reports a server error when Telegram rejects the bot token', async () => {
    sendMessage.mockRejectedValue(
      new TelegramApiError('unauthorized', 'Telegram rejected the bot token'),
    );

    await expect(service.send(chatIds(12), 'Hello')).rejects.toThrow(
      InternalServerErrorException,
    );
    // Only the first concurrent batch was attempted.
    expect(sendMessage).toHaveBeenCalledTimes(5);
  });
});
