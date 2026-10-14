import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Mock } from 'vitest';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  type SendResult,
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

/** A delivery, after `failedAttempts` retried attempts. */
function sent(messageId?: number, failedAttempts: string[] = []): SendResult {
  return { messageId, failedAttempts };
}

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
      .mockResolvedValue(sent(MESSAGE_ID));
    sendPhoto = vi
      .fn<TelegramService['sendPhoto']>()
      .mockResolvedValue(sent(43));
    sendDocument = vi
      .fn<TelegramService['sendDocument']>()
      .mockResolvedValue(sent(44));
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
        new Promise((resolve) =>
          setTimeout(() => resolve(sent(1)), chatId === '1' ? 20 : 1),
        ),
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
      return sent(1);
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
      return sent(1);
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

  describe('with one attachment', () => {
    it('sends it with the message as its caption, as a single post', async () => {
      const chart = attachment('cpu.png', true);

      await expect(service.send(['123'], 'CPU high', [chart])).resolves.toEqual(
        {
          total: 1,
          sent: 1,
          failed: 0,
          results: [{ chat_id: '123', success: true }],
        },
      );
      expect(sendPhoto).toHaveBeenCalledWith('123', chart, {
        caption: 'CPU high',
      });
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('sends it to every chat', async () => {
      await expect(
        service.send(['1', '2'], 'CPU high', [attachment('top.txt')]),
      ).resolves.toMatchObject({ sent: 2 });

      expect(sendDocument.mock.calls.map(([chatId]) => chatId)).toEqual([
        '1',
        '2',
      ]);
    });

    it('sends the message separately when it is too long for a caption', async () => {
      const message = 'a'.repeat(1025);
      const log = attachment('top.txt');

      await service.send(['123'], message, [log]);

      expect(sendMessage).toHaveBeenCalledWith('123', message);
      expect(sendDocument).toHaveBeenCalledWith('123', log, {
        replyToMessageId: MESSAGE_ID,
        silent: true,
      });
    });

    it('sends an image as a file with the caption when Telegram refuses it as a photo', async () => {
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
      expect(sendDocument).toHaveBeenCalledWith('123', screenshot, {
        caption: 'Page broken',
      });
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('still sends the message as text when Telegram refuses the file', async () => {
      sendDocument.mockRejectedValue(
        new TelegramApiError(
          'rejected',
          'Telegram API error 400: Bad Request: file must be non-empty',
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
              'Attachment 1 ("top.txt"): Telegram API error 400: Bad Request: file must be non-empty',
          },
        ],
      });
      expect(sendMessage).toHaveBeenCalledWith('123', 'CPU high');
    });

    it('reports the message error when the text fallback fails too', async () => {
      const notFound = new TelegramApiError(
        'rejected',
        'Telegram API error 400: Bad Request: chat not found',
      );
      sendDocument.mockRejectedValue(notFound);
      sendMessage.mockRejectedValue(notFound);

      await expect(
        service.send(['123'], 'CPU high', [attachment('top.txt')]),
      ).resolves.toMatchObject({
        results: [{ chat_id: '123', success: false, error: notFound.message }],
      });
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
      'still sends the message as text after a $reason failure',
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
        // The photo may have arrived, so it is not resent as a file, but the
        // alert text goes out: a duplicate beats a lost alert.
        expect(sendDocument).not.toHaveBeenCalled();
        expect(sendMessage).toHaveBeenCalledWith('123', 'CPU high');
      },
    );

    it('hides unexpected errors behind a generic message', async () => {
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

  describe('with several attachments', () => {
    const silentReply = { replyToMessageId: MESSAGE_ID, silent: true };

    it('sends the message, then each attachment as an uncaptioned silent reply', async () => {
      const chart = attachment('cpu.png', true);
      const log = attachment('top.txt');

      await expect(
        service.send(['123'], 'CPU high', [chart, log]),
      ).resolves.toMatchObject({ sent: 1, failed: 0 });

      expect(sendMessage).toHaveBeenCalledWith('123', 'CPU high');
      expect(sendPhoto).toHaveBeenCalledWith('123', chart, silentReply);
      expect(sendDocument).toHaveBeenCalledWith('123', log, silentReply);
      expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
        sendPhoto.mock.invocationCallOrder[0],
      );
      expect(sendPhoto.mock.invocationCallOrder[0]).toBeLessThan(
        sendDocument.mock.invocationCallOrder[0],
      );
    });

    it('sends attachments without a reply when the message ID is unknown', async () => {
      sendMessage.mockResolvedValue(sent());

      await service.send(['123'], 'CPU high', [
        attachment('a.txt'),
        attachment('b.txt'),
      ]);

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
        service.send(['123'], 'Page broken', [screenshot, attachment('a.txt')]),
      ).resolves.toMatchObject({ sent: 1, failed: 0 });
      expect(sendDocument).toHaveBeenCalledWith('123', screenshot, silentReply);
    });

    it('stops at the first failed attachment and names it in the error', async () => {
      sendDocument.mockImplementation(async (_chatId, file) => {
        if (file.filename === 'top.txt') {
          throw new TelegramApiError(
            'rejected',
            'Telegram API error 400: Bad Request: file must be non-empty',
          );
        }
        return sent(44);
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
        service.send(['123'], 'CPU high', [
          attachment('a.txt'),
          attachment('b.txt'),
        ]),
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
  });

  describe('warnings', () => {
    const RESET =
      'Could not reach Telegram (ECONNRESET); delivery could not be confirmed';

    it('reports attempts that failed before the message got through', async () => {
      sendMessage.mockResolvedValue(sent(MESSAGE_ID, [RESET]));

      await expect(service.send(['123'], 'CPU high')).resolves.toEqual({
        total: 1,
        sent: 1,
        failed: 0,
        results: [
          {
            chat_id: '123',
            success: true,
            warnings: [`Message: attempt 1 failed and was retried: ${RESET}`],
          },
        ],
      });
    });

    it('names the attachment whose upload needed retries', async () => {
      sendDocument.mockResolvedValue(sent(44, [RESET, RESET]));

      await expect(
        service.send(['123'], 'CPU high', [attachment('top.txt')]),
      ).resolves.toMatchObject({
        results: [
          {
            success: true,
            warnings: [
              `Attachment 1 ("top.txt"): attempt 1 failed and was retried: ${RESET}`,
              `Attachment 1 ("top.txt"): attempt 2 failed and was retried: ${RESET}`,
            ],
          },
        ],
      });
    });

    it('reports a photo sent as a file', async () => {
      sendPhoto.mockRejectedValue(
        new TelegramApiError(
          'rejected',
          'Telegram API error 400: Bad Request: PHOTO_INVALID_DIMENSIONS',
        ),
      );

      await expect(
        service.send(['123'], 'Page broken', [attachment('page.png', true)]),
      ).resolves.toMatchObject({
        results: [
          {
            success: true,
            warnings: [
              'Attachment 1 ("page.png"): sent as a file because Telegram refused it as a photo: Telegram API error 400: Bad Request: PHOTO_INVALID_DIMENSIONS',
            ],
          },
        ],
      });
    });

    it('reports the attempts behind a final failure, and the text fallback', async () => {
      sendDocument.mockRejectedValue(
        new TelegramApiError(
          'network_error',
          `${RESET} (after 2 attempts)`,
          undefined,
          [RESET],
        ),
      );

      await expect(
        service.send(['123'], 'CPU high', [attachment('top.txt')]),
      ).resolves.toEqual({
        total: 1,
        sent: 0,
        failed: 1,
        results: [
          {
            chat_id: '123',
            success: false,
            error: `Attachment 1 ("top.txt"): ${RESET} (after 2 attempts)`,
            warnings: [
              `Attachment 1 ("top.txt"): attempt 1 failed and was retried: ${RESET}`,
              'Message: sent as text on its own because the file could not be delivered',
            ],
          },
        ],
      });
    });

    it('keeps the warnings of each chat separate', async () => {
      sendMessage.mockImplementation(async (chatId) =>
        chatId === '2' ? sent(1, [RESET]) : sent(1),
      );

      const summary = await service.send(['1', '2'], 'CPU high');

      expect(summary.results).toEqual([
        { chat_id: '1', success: true },
        {
          chat_id: '2',
          success: true,
          warnings: [`Message: attempt 1 failed and was retried: ${RESET}`],
        },
      ]);
    });
  });
});
