import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Mock } from 'vitest';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { TelegramService } from './telegram.service.js';

const TOKEN = '123456789:unit-test-token';
const BOT_URL = `https://api.telegram.org/bot${TOKEN}`;
const SEND_MESSAGE_URL = `${BOT_URL}/sendMessage`;

function createService(timeoutMs = 1_000): TelegramService {
  const values: Partial<EnvironmentVariables> = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_REQUEST_TIMEOUT_MS: timeoutMs,
  };
  const config = { get: (key: keyof EnvironmentVariables) => values[key] };
  return new TelegramService(
    config as unknown as ConfigService<EnvironmentVariables, true>,
  );
}

function telegramResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const delivered = () =>
  telegramResponse(200, { ok: true, result: { message_id: 1 } });

const failure = (code: number, description: string, parameters?: object) =>
  telegramResponse(code, {
    ok: false,
    error_code: code,
    description,
    parameters,
  });

const rateLimited = (retryAfter: number) =>
  failure(429, `Too Many Requests: retry after ${retryAfter}`, {
    retry_after: retryAfter,
  });

const report = () => ({
  filename: 'top.txt',
  content: new Blob(['load average: 9.87'], { type: 'text/plain' }),
});

/** The form fields of an upload, with files replaced by their name and text. */
async function formFields(
  init: RequestInit | undefined,
): Promise<Record<string, unknown>> {
  const body = init?.body;
  if (!(body instanceof FormData)) {
    throw new Error('Expected a multipart/form-data body');
  }
  const fields: Record<string, unknown> = {};
  for (const [name, value] of body) {
    fields[name] =
      typeof value === 'string'
        ? value
        : { filename: value.name, text: await value.text() };
  }
  return fields;
}

describe('TelegramService', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('posts the chat ID and text to sendMessage as JSON', async () => {
    fetchMock.mockResolvedValue(delivered());

    await createService().sendMessage('-1001234567890', 'Server is down!');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SEND_MESSAGE_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: '-1001234567890',
      text: 'Server is down!',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('resolves with the ID of the sent message', async () => {
    fetchMock.mockResolvedValue(
      telegramResponse(200, { ok: true, result: { message_id: 42 } }),
    );

    await expect(createService().sendMessage('123', 'hi')).resolves.toBe(42);
  });

  it('resolves without an ID when Telegram does not return one', async () => {
    fetchMock.mockResolvedValue(telegramResponse(200, { ok: true }));

    await expect(
      createService().sendMessage('123', 'hi'),
    ).resolves.toBeUndefined();
  });

  it('uploads a photo as multipart form data with the given options', async () => {
    fetchMock.mockResolvedValue(delivered());

    await expect(
      createService().sendPhoto(
        '-1001234567890',
        {
          filename: 'cpu.png',
          content: new Blob(['png bytes'], { type: 'image/png' }),
        },
        { caption: 'cpu.png', replyToMessageId: 7, silent: true },
      ),
    ).resolves.toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BOT_URL}/sendPhoto`);
    expect(init?.method).toBe('POST');
    // fetch derives the multipart Content-Type, including the boundary.
    expect(init?.headers).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    await expect(formFields(init)).resolves.toEqual({
      chat_id: '-1001234567890',
      photo: { filename: 'cpu.png', text: 'png bytes' },
      caption: 'cpu.png',
      reply_parameters: JSON.stringify({
        message_id: 7,
        allow_sending_without_reply: true,
      }),
      disable_notification: 'true',
    });
  });

  it('uploads a document with no optional fields by default', async () => {
    fetchMock.mockResolvedValue(delivered());

    await createService().sendDocument('123', report());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BOT_URL}/sendDocument`);
    await expect(formFields(init)).resolves.toEqual({
      chat_id: '123',
      document: { filename: 'top.txt', text: 'load average: 9.87' },
    });
  });

  it('reports upload errors like message errors', async () => {
    fetchMock.mockResolvedValue(
      failure(400, 'Bad Request: PHOTO_INVALID_DIMENSIONS'),
    );

    await expect(
      createService().sendPhoto('123', report()),
    ).rejects.toMatchObject({
      reason: 'rejected',
      message: 'Telegram API error 400: Bad Request: PHOTO_INVALID_DIMENSIONS',
    });
  });

  it('reports Telegram API errors with their description', async () => {
    fetchMock.mockResolvedValue(failure(400, 'Bad Request: chat not found'));

    await expect(
      createService().sendMessage('123', 'hi'),
    ).rejects.toMatchObject({
      reason: 'rejected',
      message: 'Telegram API error 400: Bad Request: chat not found',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('points to the new chat ID when a group was upgraded to a supergroup', async () => {
    fetchMock.mockResolvedValue(
      failure(
        400,
        'Bad Request: group chat was upgraded to a supergroup chat',
        { migrate_to_chat_id: -1001234567890 },
      ),
    );

    await expect(createService().sendMessage('-123', 'hi')).rejects.toThrow(
      '(the group is now chat ID -1001234567890)',
    );
  });

  it.each([
    [401, 'Unauthorized'],
    [404, 'Not Found'],
  ])('treats HTTP %i as a rejected bot token', async (code, description) => {
    fetchMock.mockResolvedValue(failure(code, description));

    await expect(
      createService().sendMessage('123', 'hi'),
    ).rejects.toMatchObject({
      reason: 'unauthorized',
      message: 'Telegram rejected the bot token',
    });
  });

  describe('when rate limited (HTTP 429)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
    });

    it('waits retry_after seconds, then retries once', async () => {
      fetchMock
        .mockResolvedValueOnce(rateLimited(2))
        .mockResolvedValueOnce(delivered());

      const sending = createService().sendMessage('123', 'hi');
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(sending).resolves.toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('uploads the file again on the retry', async () => {
      fetchMock
        .mockResolvedValueOnce(rateLimited(1))
        .mockResolvedValueOnce(delivered());

      const sending = createService().sendDocument('123', report());
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(sending).resolves.toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [url, init] of fetchMock.mock.calls) {
        expect(url).toBe(`${BOT_URL}/sendDocument`);
        await expect(formFields(init)).resolves.toMatchObject({
          document: { filename: 'top.txt', text: 'load average: 9.87' },
        });
      }
    });

    it('gives up when the retry is rate limited too', async () => {
      fetchMock.mockImplementation(async () => rateLimited(1));

      const outcome = expect(
        createService().sendMessage('123', 'hi'),
      ).rejects.toMatchObject({ reason: 'rate_limited' });
      await vi.advanceTimersByTimeAsync(1_000);

      await outcome;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fails without waiting when retry_after is too long', async () => {
      fetchMock.mockResolvedValue(rateLimited(30));

      await expect(
        createService().sendMessage('123', 'hi'),
      ).rejects.toMatchObject({
        reason: 'rate_limited',
        message: 'Rate limited by Telegram; retry after 30 seconds',
        retryAfterSeconds: 30,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('does not retry Telegram server errors', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>Bad Gateway</html>', { status: 502 }),
    );

    await expect(
      createService().sendMessage('123', 'hi'),
    ).rejects.toMatchObject({
      reason: 'server_error',
      message:
        'Telegram server error (HTTP 502); delivery could not be confirmed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports responses that are not Telegram API JSON', async () => {
    fetchMock.mockResolvedValue(new Response('OK', { status: 200 }));

    await expect(
      createService().sendMessage('123', 'hi'),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('reports network failures without retrying or logging the token', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const cause = Object.assign(
      new Error(`connect ECONNREFUSED while requesting ${SEND_MESSAGE_URL}`),
      { code: 'ECONNREFUSED' },
    );
    fetchMock.mockRejectedValue(new TypeError('fetch failed', { cause }));

    await expect(
      createService().sendMessage('123', 'hi'),
    ).rejects.toMatchObject({
      reason: 'network_error',
      message: 'Could not reach Telegram; delivery could not be confirmed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Request to Telegram failed: ECONNREFUSED',
    );
  });

  it('times out slow requests without retrying', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );

    await expect(
      createService(20).sendMessage('123', 'hi'),
    ).rejects.toMatchObject({
      reason: 'timeout',
      message:
        'Telegram did not respond within 20 ms; delivery could not be confirmed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
