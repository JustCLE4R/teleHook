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
import type { Attachment } from './attachment.js';
import { NotificationsService } from './notifications.service.js';

function chatIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => String(100_000 + i));
}

function attachment(filename: string, isPhoto = false): Attachment {
  return { filename, content: new Blob([filename]), isPhoto };
}

const MESSAGE_ID = 42;

describe('NotificationsService', () => {
  let sendMessage: Mock<TelegramService['sendMessage']>;
  let sendPhoto: Mock<TelegramService['sendPhoto']>;
  let sendDocument: Mock<TelegramService['sendDocument']>;
  let service: NotificationsService;

  function createService(maxRecipients = 20): NotificationsService {
    const config = { get: () => maxRecipients };
    return new NotificationsService(
      { sendMessage, sendPhoto, sendDocument } as unknown as TelegramService,
      config as unknown as ConfigService<EnvironmentVariables, true>,
    );
  }

  beforeEach(() => {
    sendMessage = vi
      .fn<TelegramService['sendMessage']>()
      .mockResolvedValue(MESSAGE_ID);
    sendPhoto = vi.fn<TelegramService['sendPhoto']>().mockResolvedValue(43);
    sendDocument = vi
      .fn<TelegramService['sendDocument']>()
      .mockResolvedValue(44);
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

  describe('with attachments', () => {
    const silentReply = { replyToMessageId: MESSAGE_ID, silent: true };

    it('sends each attachment after the message, as a silent reply to it', async () => {
      const chart = attachment('cpu.png', true);
      const log = attachment('top.txt');

      await expect(
        service.send(['123'], 'CPU high', [chart, log]),
      ).resolves.toEqual({
        total: 1,
        sent: 1,
        failed: 0,
        results: [{ chat_id: '123', success: true }],
      });

      expect(sendMessage).toHaveBeenCalledWith('123', 'CPU high');
      // Photos show no file name, so it becomes the caption.
      expect(sendPhoto).toHaveBeenCalledWith('123', chart, {
        ...silentReply,
        caption: 'cpu.png',
      });
      expect(sendDocument).toHaveBeenCalledWith('123', log, silentReply);
      expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
        sendPhoto.mock.invocationCallOrder[0],
      );
      expect(sendPhoto.mock.invocationCallOrder[0]).toBeLessThan(
        sendDocument.mock.invocationCallOrder[0],
      );
    });

    it('sends the attachments to every chat', async () => {
      await expect(
        service.send(['1', '2'], 'CPU high', [attachment('top.txt')]),
      ).resolves.toMatchObject({ sent: 2 });

      expect(sendDocument.mock.calls.map(([chatId]) => chatId)).toEqual([
        '1',
        '2',
      ]);
    });

    it('sends attachments without a reply when the message ID is unknown', async () => {
      sendMessage.mockResolvedValue(undefined);

      await service.send(['123'], 'CPU high', [attachment('top.txt')]);

      expect(sendDocument).toHaveBeenCalledWith('123', expect.anything(), {
        replyToMessageId: undefined,
        silent: true,
      });
    });

    it('sends an image as a file when Telegram refuses it as a photo', async () => {
      const screenshot = attachment('page.png', true);
      sendPhoto.mockRejectedValue(
        new TelegramApiError(
          'rejected',
          'Telegram API error 400: Bad Request: PHOTO_INVALID_DIMENSIONS',
        ),
      );

      await expect(
        service.send(['123'], 'Page broken', [screenshot]),
      ).resolves.toMatchObject({ sent: 1, failed: 0 });
      expect(sendDocument).toHaveBeenCalledWith('123', screenshot, silentReply);
    });

    it.each([
      new TelegramApiError(
        'timeout',
        'Telegram did not respond within 10000 ms; delivery could not be confirmed',
      ),
      new TelegramApiError(
        'rate_limited',
        'Rate limited by Telegram; retry after 30 seconds',
        30,
      ),
    ])(
      'does not resend a photo as a file after a $reason failure',
      async (error) => {
        sendPhoto.mockRejectedValue(error);

        await expect(
          service.send(['123'], 'CPU high', [attachment('cpu.png', true)]),
        ).resolves.toMatchObject({
          results: [
            {
              chat_id: '123',
              success: false,
              error: `Attachment 1 ("cpu.png"): ${error.message}`,
            },
          ],
        });
        expect(sendDocument).not.toHaveBeenCalled();
      },
    );

    it('stops at the first failed attachment and names it in the error', async () => {
      sendDocument.mockImplementation(async (_chatId, file) => {
        if (file.filename === 'top.txt') {
          throw new TelegramApiError(
            'rejected',
            'Telegram API error 400: Bad Request: file must be non-empty',
          );
        }
        return 44;
      });

      await expect(
        service.send(['123'], 'CPU high', [
          attachment('dmesg.txt'),
          attachment('top.txt'),
          attachment('ps.txt'),
        ]),
      ).resolves.toEqual({
        total: 1,
        sent: 0,
        failed: 1,
        results: [
          {
            chat_id: '123',
            success: false,
            error:
              'Attachment 2 ("top.txt"): Telegram API error 400: Bad Request: file must be non-empty',
          },
        ],
      });
      expect(sendDocument.mock.calls.map(([, file]) => file.filename)).toEqual([
        'dmesg.txt',
        'top.txt',
      ]);
    });

    it('does not send attachments when the message fails', async () => {
      sendMessage.mockRejectedValue(
        new TelegramApiError(
          'rejected',
          'Telegram API error 403: Forbidden: bot was blocked by the user',
        ),
      );

      await expect(
        service.send(['123'], 'CPU high', [attachment('top.txt')]),
      ).resolves.toMatchObject({
        results: [
          {
            chat_id: '123',
            success: false,
            error:
              'Telegram API error 403: Forbidden: bot was blocked by the user',
          },
        ],
      });
      expect(sendDocument).not.toHaveBeenCalled();
    });

    it('hides unexpected attachment errors behind a generic message', async () => {
      sendDocument.mockRejectedValue(new Error('internal detail'));

      await expect(
        service.send(['123'], 'CPU high', [attachment('top.txt')]),
      ).resolves.toMatchObject({
        results: [
          {
            chat_id: '123',
            success: false,
            error:
              'Attachment 1 ("top.txt"): Unexpected error while sending the file',
          },
        ],
      });
    });

    it('reports a server error when Telegram rejects the bot token during an upload', async () => {
      sendDocument.mockRejectedValue(
        new TelegramApiError('unauthorized', 'Telegram rejected the bot token'),
      );

      await expect(
        service.send(['123'], 'CPU high', [attachment('top.txt')]),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });
});
