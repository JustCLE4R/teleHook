import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Mock } from 'vitest';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { TelegramService } from './telegram.service.js';

const TOKEN = '123456789:unit-test-token';
const BOT_URL = `https://api.telegram.org/bot${TOKEN}`;
const SEND_MESSAGE_URL = `${BOT_URL}/sendMessage`;

/** Retries are off unless a test asks for them. */
function createService(timeoutMs = 1_000, maxRetries = 0): TelegramService {
  const values: Partial<EnvironmentVariables> = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_REQUEST_TIMEOUT_MS: timeoutMs,
    TELEGRAM_MAX_RETRIES: maxRetries,
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

  it('reports Telegram server errors', async () => {
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

  it('reports network failures without logging the token', async () => {
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

  it('times out slow requests', async () => {
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

  it('fails without retrying when retries are disabled', async () => {
    fetchMock.mockResolvedValue(rateLimited(1));

    await expect(
      createService().sendMessage('123', 'hi'),
    ).rejects.toMatchObject({
      reason: 'rate_limited',
      message: 'Rate limited by Telegram; retry after 1 seconds',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('with retries', () => {
    const resetByPeer = () =>
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), {
          code: 'ECONNRESET',
        }),
      });

    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });

    it('retries a dropped connection after 1 second', async () => {
      fetchMock
        .mockRejectedValueOnce(resetByPeer())
        .mockResolvedValueOnce(delivered());

      const sending = createService(1_000, 3).sendMessage('123', 'hi');
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(sending).resolves.toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        'sendMessage failed (Could not reach Telegram; delivery could not be confirmed); retry 1 of 3 in 1000 ms',
      );
    });

    it.each([
      ['a server error', () => new Response('Bad Gateway', { status: 502 })],
      ['a response that is not Telegram JSON', () => new Response('OK')],
    ])('retries after %s', async (_case, response) => {
      fetchMock
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(delivered());

      const sending = createService(1_000, 3).sendMessage('123', 'hi');
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(sending).resolves.toBe(1);
    });

    it('doubles the wait for each retry, then reports the attempts', async () => {
      fetchMock.mockRejectedValue(resetByPeer());

      const outcome = expect(
        createService(1_000, 3).sendMessage('123', 'hi'),
      ).rejects.toMatchObject({
        reason: 'network_error',
        message:
          'Could not reach Telegram; delivery could not be confirmed (after 4 attempts)',
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(4_000);

      await outcome;
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('retries a timed-out request', async () => {
      fetchMock
        .mockRejectedValueOnce(
          new DOMException('The operation timed out', 'TimeoutError'),
        )
        .mockResolvedValueOnce(delivered());

      const sending = createService(1_000, 1).sendMessage('123', 'hi');
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(sending).resolves.toBe(1);
    });

    it('waits retry_after seconds when rate limited', async () => {
      fetchMock
        .mockResolvedValueOnce(rateLimited(2))
        .mockResolvedValueOnce(delivered());

      const sending = createService(1_000, 3).sendMessage('123', 'hi');
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(sending).resolves.toBe(1);
    });

    it('fails without waiting when retry_after is longer than 30 seconds', async () => {
      fetchMock.mockResolvedValue(rateLimited(31));

      await expect(
        createService(1_000, 3).sendMessage('123', 'hi'),
      ).rejects.toMatchObject({
        reason: 'rate_limited',
        message: 'Rate limited by Telegram; retry after 31 seconds',
        retryAfterSeconds: 31,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('uploads the file again on a retry', async () => {
      fetchMock
        .mockRejectedValueOnce(resetByPeer())
        .mockResolvedValueOnce(delivered());

      const sending = createService(1_000, 3).sendDocument('123', report());
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

    it.each([
      ['a refusal', () => failure(400, 'Bad Request: chat not found')],
      ['a rejected bot token', () => failure(401, 'Unauthorized')],
    ])('does not retry %s', async (_case, response) => {
      fetchMock.mockResolvedValue(response());

      await expect(
        createService(1_000, 3).sendMessage('123', 'hi'),
      ).rejects.toBeInstanceOf(Error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports a refusal that follows a retry with the attempt count', async () => {
      fetchMock
        .mockRejectedValueOnce(resetByPeer())
        .mockResolvedValueOnce(failure(400, 'Bad Request: chat not found'));

      const outcome = expect(
        createService(1_000, 3).sendMessage('123', 'hi'),
      ).rejects.toMatchObject({
        reason: 'rejected',
        message:
          'Telegram API error 400: Bad Request: chat not found (after 2 attempts)',
      });
      await vi.advanceTimersByTimeAsync(1_000);

      await outcome;
    });
  });
});
