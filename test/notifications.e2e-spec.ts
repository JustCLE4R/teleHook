import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { Mock } from 'vitest';
import { AppModule } from '../src/app.module.js';

// Matches the environment in vitest.config.e2e.ts.
const TOKEN = '123456789:e2e-test-token';
const MAX_RECIPIENTS = 20;
const RATE_LIMIT = 5;

const CHAT_ID_FORMAT_ERROR =
  'each chat ID must be a numeric Telegram chat ID such as "123456789" or "-1001234567890"';

function telegramResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const delivered = () =>
  telegramResponse(200, { ok: true, result: { message_id: 1 } });

const failure = (code: number, description: string) =>
  telegramResponse(code, { ok: false, error_code: code, description });

function chatIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => String(100_000 + i));
}

function chatIdOf(init: RequestInit | undefined): string {
  return (JSON.parse(init?.body as string) as { chat_id: string }).chat_id;
}

describe('POST /api/send (e2e)', () => {
  let app: INestApplication<App>;
  let fetchMock: Mock<typeof fetch>;

  const post = (body: object) =>
    request(app.getHttpServer()).post('/api/send').send(body);

  beforeEach(async () => {
    fetchMock = vi.fn<typeof fetch>(async () => delivered());
    vi.stubGlobal('fetch', fetchMock);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('delivers a message to one chat', async () => {
    const res = await post({
      chat_ids: ['123456789'],
      message: 'Hello from NestJS!',
    }).expect(200);

    expect(res.body).toEqual({
      success: true,
      message: 'Notification processing completed',
      data: {
        total: 1,
        sent: 1,
        failed: 0,
        results: [{ chat_id: '123456789', success: true }],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: '123456789',
      text: 'Hello from NestJS!',
    });
  });

  it('delivers a message to multiple chats', async () => {
    const res = await post({
      chat_ids: ['123456789', '-1001234567890'],
      message: 'Server is down!',
    }).expect(200);

    expect(res.body).toEqual({
      success: true,
      message: 'Notification processing completed',
      data: {
        total: 2,
        sent: 2,
        failed: 0,
        results: [
          { chat_id: '123456789', success: true },
          { chat_id: '-1001234567890', success: true },
        ],
      },
    });
    expect(fetchMock.mock.calls.map(([, init]) => chatIdOf(init))).toEqual([
      '123456789',
      '-1001234567890',
    ]);
  });

  it('responds 207 with per-chat results when some deliveries fail', async () => {
    fetchMock.mockImplementation(async (_url, init) =>
      chatIdOf(init) === '222'
        ? failure(403, 'Forbidden: bot was blocked by the user')
        : delivered(),
    );

    const res = await post({
      chat_ids: ['111', '222', '333'],
      message: 'Hello',
    }).expect(207);

    expect(res.body).toEqual({
      success: false,
      message: 'Notification processing completed with failures',
      data: {
        total: 3,
        sent: 2,
        failed: 1,
        results: [
          { chat_id: '111', success: true },
          {
            chat_id: '222',
            success: false,
            error:
              'Telegram API error 403: Forbidden: bot was blocked by the user',
          },
          { chat_id: '333', success: true },
        ],
      },
    });
  });

  it('reports Telegram API errors for each chat', async () => {
    fetchMock.mockImplementation(async () =>
      failure(400, 'Bad Request: chat not found'),
    );

    const res = await post({ chat_ids: ['1', '2'], message: 'Hello' }).expect(
      207,
    );

    expect(res.body).toMatchObject({
      success: false,
      data: { total: 2, sent: 0, failed: 2 },
    });
    expect(res.body.data.results).toEqual([
      {
        chat_id: '1',
        success: false,
        error: 'Telegram API error 400: Bad Request: chat not found',
      },
      {
        chat_id: '2',
        success: false,
        error: 'Telegram API error 400: Bad Request: chat not found',
      },
    ]);
  });

  it('reports network failures and timeouts for each chat', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (chatIdOf(init) === '1') {
        throw new TypeError('fetch failed');
      }
      throw new DOMException('The operation timed out', 'TimeoutError');
    });

    const res = await post({ chat_ids: ['1', '2'], message: 'Hello' }).expect(
      207,
    );

    expect(res.body.data.results).toEqual([
      {
        chat_id: '1',
        success: false,
        error: 'Could not reach Telegram; delivery could not be confirmed',
      },
      {
        chat_id: '2',
        success: false,
        error:
          'Telegram did not respond within 1000 ms; delivery could not be confirmed',
      },
    ]);
  });

  it('responds 500 without exposing the token when Telegram rejects it', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async () => failure(401, 'Unauthorized'));

    const res = await post({ chat_ids: ['1'], message: 'Hello' }).expect(500);

    expect(res.body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message:
        'Telegram delivery is unavailable because of a server configuration error',
    });
    expect(res.text).not.toContain(TOKEN);
  });

  describe('request validation', () => {
    it.each([
      [
        'a missing chat_ids field',
        { message: 'Hello' },
        'chat_ids must be an array of chat ID strings',
      ],
      [
        'chat_ids that is not an array',
        { chat_ids: '123456789', message: 'Hello' },
        'chat_ids must be an array of chat ID strings',
      ],
      [
        'an empty chat_ids array',
        { chat_ids: [], message: 'Hello' },
        'chat_ids must contain at least one chat ID',
      ],
      [
        'a numeric chat ID',
        { chat_ids: [123456789], message: 'Hello' },
        'each chat ID must be a string',
      ],
      [
        'duplicate chat IDs',
        { chat_ids: ['123', '456', '123'], message: 'Hello' },
        'chat_ids must not contain duplicates',
      ],
      ['a missing message', { chat_ids: ['123'] }, 'message must be a string'],
      [
        'a non-string message',
        { chat_ids: ['123'], message: 42 },
        'message must be a string',
      ],
      [
        'an empty message',
        { chat_ids: ['123'], message: '' },
        'message must not be empty or whitespace only',
      ],
      [
        'a whitespace-only message',
        { chat_ids: ['123'], message: ' \n\t ' },
        'message must not be empty or whitespace only',
      ],
      [
        'a message longer than 4096 characters',
        { chat_ids: ['123'], message: 'a'.repeat(4097) },
        'message must be at most 4096 characters long',
      ],
      [
        'emoji text longer than 4096 UTF-16 code units',
        { chat_ids: ['123'], message: '🚀'.repeat(2049) },
        'message must be at most 4096 characters long',
      ],
      [
        'an unexpected property',
        { chat_ids: ['123'], message: 'Hello', parse_mode: 'HTML' },
        'property parse_mode should not exist',
      ],
    ])('rejects %s', async (_case, body, expectedError) => {
      const res = await post(body).expect(400);

      expect(res.body.message).toEqual([expectedError]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      '',
      'abc',
      '12.5',
      '+123',
      '0123',
      '0',
      '-0',
      ' 123',
      '1e9',
      '12345678901234567',
      '@channelname',
    ])('rejects the malformed chat ID %j', async (chatId) => {
      const res = await post({ chat_ids: [chatId], message: 'Hello' }).expect(
        400,
      );

      expect(res.body.message).toEqual([CHAT_ID_FORMAT_ERROR]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports every invalid field of an empty body', async () => {
      const res = await post({}).expect(400);

      expect(res.body.message).toEqual([
        'chat_ids must be an array of chat ID strings',
        'message must be a string',
      ]);
    });

    it('accepts a message of exactly 4096 characters', async () => {
      await post({ chat_ids: ['123'], message: 'a'.repeat(4096) }).expect(200);
    });

    it(`accepts up to ${MAX_RECIPIENTS} recipients`, async () => {
      await post({
        chat_ids: chatIds(MAX_RECIPIENTS),
        message: 'Hello',
      }).expect(200);

      expect(fetchMock).toHaveBeenCalledTimes(MAX_RECIPIENTS);
    });

    it(`rejects more than ${MAX_RECIPIENTS} recipients`, async () => {
      const res = await post({
        chat_ids: chatIds(MAX_RECIPIENTS + 1),
        message: 'Hello',
      }).expect(400);

      expect(res.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: [`chat_ids must contain at most ${MAX_RECIPIENTS} chat IDs`],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON', async () => {
      await request(app.getHttpServer())
        .post('/api/send')
        .set('Content-Type', 'application/json')
        .send('{"chat_ids": [')
        .expect(400);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a JSON array body', async () => {
      await post([{ chat_ids: ['123'], message: 'Hello' }]).expect(400);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a request without a body', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/send')
        .set('Content-Type', 'application/json')
        .expect(400);

      expect(res.body.message).toEqual([
        'chat_ids must be an array of chat ID strings',
        'message must be a string',
      ]);
    });

    it.each([
      [
        'an HTML form',
        'application/x-www-form-urlencoded',
        'chat_ids[]=123&message=Hello',
      ],
      ['plain text', 'text/plain', '{"chat_ids":["123"],"message":"Hello"}'],
    ])('rejects %s body with 415', async (_case, contentType, body) => {
      const res = await request(app.getHttpServer())
        .post('/api/send')
        .set('Content-Type', contentType)
        .send(body)
        .expect(415);

      expect(res.body.message).toBe('Content-Type must be application/json');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it(`rate limits clients after ${RATE_LIMIT} requests`, async () => {
    const body = { chat_ids: ['123'], message: 'Hello' };
    for (let i = 0; i < RATE_LIMIT; i++) {
      await post(body).expect(200);
    }

    const res = await post(body).expect(429);

    expect(res.body.message).toBe('Too many requests, please try again later');
    expect(res.headers['retry-after']).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMIT);
  });
});

describe('startup configuration (e2e)', () => {
  it('refuses to start without a Telegram bot token', async () => {
    // An empty value rather than an unset one: environment variables take
    // precedence over .env, so a developer's local token cannot mask the test.
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    vi.resetModules();
    const { AppModule: UnconfiguredAppModule } =
      await import('../src/app.module.js');

    await expect(
      Test.createTestingModule({ imports: [UnconfiguredAppModule] }).compile(),
    ).rejects.toThrow('TELEGRAM_BOT_TOKEN must be set');
  });
});
