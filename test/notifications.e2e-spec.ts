import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { Mock } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { currentRequestId } from '../src/logging/request-context.js';

// Matches the environment in vitest.config.e2e.ts.
const TOKEN = '123456789:e2e-test-token';
const MAX_RECIPIENTS = 20;
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const RATE_LIMIT = 5;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

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
  if (init?.body instanceof FormData) {
    return init.body.get('chat_id') as string;
  }
  return (JSON.parse(init?.body as string) as { chat_id: string }).chat_id;
}

/** The Bot API method and parameters of a Telegram call; files as name and text. */
async function telegramCall([url, init]: Parameters<typeof fetch>): Promise<{
  method: string | undefined;
  params: Record<string, unknown>;
}> {
  // TelegramService always passes the URL as a string.
  const method = typeof url === 'string' ? url.split('/').pop() : undefined;
  if (!(init?.body instanceof FormData)) {
    return { method, params: JSON.parse(init?.body as string) };
  }
  const params: Record<string, unknown> = {};
  for (const [name, value] of init.body) {
    params[name] =
      typeof value === 'string'
        ? value
        : { filename: value.name, text: await value.text() };
  }
  return { method, params };
}

describe('POST /api/send (e2e)', () => {
  let app: INestApplication<App>;
  let fetchMock: Mock<typeof fetch>;

  const post = (body: object) =>
    request(app.getHttpServer()).post('/api/send').send(body);

  /** A multipart request; add fields with .field() and files with .attach(). */
  const postForm = () => request(app.getHttpServer()).post('/api/send');

  const telegramCalls = () =>
    Promise.all(fetchMock.mock.calls.map((call) => telegramCall(call)));

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

  describe('request IDs', () => {
    const UUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const body = { chat_ids: ['123'], message: 'Hello' };

    it('returns a new request ID', async () => {
      const res = await post(body).expect(200);

      expect(res.headers['x-request-id']).toMatch(UUID);
    });

    it("keeps the caller's request ID", async () => {
      const res = await post(body)
        .set('X-Request-Id', 'cpu-check.42')
        .expect(200);

      expect(res.headers['x-request-id']).toBe('cpu-check.42');
    });

    it('replaces a request ID that could forge log content', async () => {
      const res = await post(body)
        .set('X-Request-Id', 'x" {"level":"error"}')
        .expect(200);

      expect(res.headers['x-request-id']).toMatch(UUID);
    });

    it('tags the logs written while handling the request', async () => {
      const seen: (string | undefined)[] = [];
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
        seen.push(currentRequestId());
      });
      fetchMock.mockImplementation(async () => {
        throw new TypeError('fetch failed');
      });

      const res = await postForm()
        .field('chat_ids', '123')
        .field('message', 'Hello')
        .attach('files', Buffer.from('x'), 'top.txt')
        .expect(207);

      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(new Set([res.headers['x-request-id']]));
    });
  });

  it('retries a dropped connection, delivers, and reports the retry', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const reset = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    });
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: reset }))
      .mockImplementation(async () => delivered());

    const res = await post({ chat_ids: ['1'], message: 'Hello' }).expect(200);

    expect(res.body).toEqual({
      success: true,
      message: 'Notification processing completed',
      data: {
        total: 1,
        sent: 1,
        failed: 0,
        results: [
          {
            chat_id: '1',
            success: true,
            warnings: [
              'Message: attempt 1 failed and was retried: Could not reach Telegram (ECONNRESET); delivery could not be confirmed',
            ],
          },
        ],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports network failures and timeouts that outlast the retries', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
        error:
          'Could not reach Telegram; delivery could not be confirmed (after 2 attempts)',
        warnings: [
          'Message: attempt 1 failed and was retried: Could not reach Telegram; delivery could not be confirmed',
        ],
      },
      {
        chat_id: '2',
        success: false,
        error:
          'Telegram did not respond within 1000 ms; delivery could not be confirmed (after 2 attempts)',
        warnings: [
          'Message: attempt 1 failed and was retried: Telegram did not respond within 1000 ms; delivery could not be confirmed',
        ],
      },
    ]);
    // One retry each, as configured in vitest.config.e2e.ts.
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

      expect(res.body.message).toBe(
        'Content-Type must be application/json or multipart/form-data',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('attachments (multipart/form-data)', () => {
    it('sends the message, then each file as a silent reply to it', async () => {
      const res = await postForm()
        .field('chat_ids', '123456789')
        .field('message', 'Disk almost full on web-1')
        .attach('files', PNG, 'disk.png')
        .attach('files', Buffer.from('/dev/sda1  98%  /'), 'df.txt')
        .expect(200);

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
      const reply = {
        reply_parameters: JSON.stringify({
          message_id: 1,
          allow_sending_without_reply: true,
        }),
        disable_notification: 'true',
      };
      await expect(telegramCalls()).resolves.toEqual([
        {
          method: 'sendMessage',
          params: { chat_id: '123456789', text: 'Disk almost full on web-1' },
        },
        {
          method: 'sendPhoto',
          params: {
            chat_id: '123456789',
            photo: { filename: 'disk.png', text: PNG.toString() },
            ...reply,
          },
        },
        {
          method: 'sendDocument',
          params: {
            chat_id: '123456789',
            document: { filename: 'df.txt', text: '/dev/sda1  98%  /' },
            ...reply,
          },
        },
      ]);
    });

    it('accepts a text-only form', async () => {
      await postForm()
        .field('chat_ids', '123')
        .field('message', 'Hello')
        .expect(200);

      await expect(telegramCalls()).resolves.toEqual([
        { method: 'sendMessage', params: { chat_id: '123', text: 'Hello' } },
      ]);
    });

    it.each([
      [
        'repeated fields',
        [
          ['chat_ids', '111'],
          ['chat_ids', '222'],
        ],
      ],
      ['a comma-separated list', [['chat_ids', '111, 222']]],
      [
        'bracketed fields, as axios sends them',
        [
          ['chat_ids[]', '111'],
          ['chat_ids[]', '222'],
        ],
      ],
    ])('accepts chat IDs as %s', async (_case, fields) => {
      const req = postForm().field('message', 'Hello');
      for (const [name, value] of fields) {
        req.field(name, value);
      }

      const res = await req.expect(200);

      expect(res.body.data.results).toEqual([
        { chat_id: '111', success: true },
        { chat_id: '222', success: true },
      ]);
    });

    it('sends a single file with the message as its caption', async () => {
      await postForm()
        .field('chat_ids', '123')
        .field('message', 'Disk almost full on web-1')
        .attach('files', PNG, 'disk.png')
        .expect(200);

      await expect(telegramCalls()).resolves.toEqual([
        {
          method: 'sendPhoto',
          params: {
            chat_id: '123',
            photo: { filename: 'disk.png', text: PNG.toString() },
            caption: 'Disk almost full on web-1',
          },
        },
      ]);
    });

    it('keeps UTF-8 file names', async () => {
      await postForm()
        .field('chat_ids', '123')
        .field('message', 'Hello')
        .attach('files', Buffer.from('x'), 'диагностика 1.txt')
        .expect(200);

      const calls = await telegramCalls();
      expect(calls[0].params.document).toEqual({
        filename: 'диагностика 1.txt',
        text: 'x',
      });
    });

    it('names the attachment that failed', async () => {
      fetchMock.mockImplementation(async (_url, init) => {
        const document =
          init?.body instanceof FormData ? init.body.get('document') : null;
        return chatIdOf(init) === '222' &&
          document instanceof File &&
          document.name === 'df.txt'
          ? failure(400, 'Bad Request: file must be non-empty')
          : delivered();
      });

      const res = await postForm()
        .field('chat_ids', '111,222')
        .field('message', 'Disk almost full')
        .attach('files', Buffer.from('a'), 'dmesg.txt')
        .attach('files', Buffer.from('b'), 'df.txt')
        .expect(207);

      expect(res.body.data).toEqual({
        total: 2,
        sent: 1,
        failed: 1,
        results: [
          { chat_id: '111', success: true },
          {
            chat_id: '222',
            success: false,
            error:
              'Attachment 2 ("df.txt"): Telegram API error 400: Bad Request: file must be non-empty',
          },
        ],
      });
    });

    describe('validation', () => {
      it.each([
        [
          'a missing message',
          [['chat_ids', '123']],
          'message must be a string',
        ],
        [
          'a repeated message',
          [
            ['chat_ids', '123'],
            ['message', 'a'],
            ['message', 'b'],
          ],
          'message must be a string',
        ],
        [
          'a malformed chat ID',
          [
            ['chat_ids', '123,abc'],
            ['message', 'Hello'],
          ],
          CHAT_ID_FORMAT_ERROR,
        ],
        [
          'an empty entry in a chat ID list',
          [
            ['chat_ids', '123,'],
            ['message', 'Hello'],
          ],
          CHAT_ID_FORMAT_ERROR,
        ],
        [
          'a missing chat_ids field',
          [['message', 'Hello']],
          'chat_ids must be an array of chat ID strings',
        ],
        [
          'a gap in indexed chat_ids fields',
          [
            ['chat_ids[1]', '123'],
            ['message', 'Hello'],
          ],
          'each chat ID must be a string',
        ],
        [
          'duplicate chat IDs across fields',
          [
            ['chat_ids', '123'],
            ['chat_ids', '123'],
            ['message', 'Hello'],
          ],
          'chat_ids must not contain duplicates',
        ],
        [
          'an unexpected field',
          [
            ['chat_ids', '123'],
            ['message', 'Hello'],
            ['parse_mode', 'HTML'],
          ],
          'property parse_mode should not exist',
        ],
        [
          'files sent as text instead of uploads',
          [
            ['chat_ids', '123'],
            ['message', 'Hello'],
            ['files', '/tmp/top.txt'],
          ],
          'files must be file uploads, not text fields',
        ],
        [
          'an array index far beyond the field limit',
          [
            ['chat_ids[1000000000]', '123'],
            ['message', 'Hello'],
          ],
          'Field name array index too large: chat_ids[1000000000]',
        ],
      ])('rejects %s', async (_case, fields, expectedError) => {
        const req = postForm();
        for (const [name, value] of fields) {
          req.field(name, value);
        }

        const res = await req.expect(400);

        expect(res.body.message).toEqual([expectedError]);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it(`rejects more than ${MAX_RECIPIENTS} recipients in a list`, async () => {
        const res = await postForm()
          .field('chat_ids', chatIds(MAX_RECIPIENTS + 1).join(','))
          .field('message', 'Hello')
          .expect(400);

        expect(res.body.message).toEqual([
          `chat_ids must contain at most ${MAX_RECIPIENTS} chat IDs`,
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it(`accepts files of up to ${MAX_ATTACHMENT_BYTES} bytes`, async () => {
        await postForm()
          .field('chat_ids', '123')
          .field('message', 'Hello')
          .attach('files', Buffer.alloc(MAX_ATTACHMENT_BYTES, 'a'), 'big.log')
          .expect(200);
      });

      it('rejects a larger file with 413', async () => {
        const res = await postForm()
          .field('chat_ids', '123')
          .field('message', 'Hello')
          .attach('files', Buffer.from('x'), 'small.log')
          .attach('files', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), 'big.log')
          .expect(413);

        expect(res.body.message).toBe(
          'each file must be at most 1 MB ("big.log" is larger)',
        );
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it(`rejects more than ${MAX_ATTACHMENTS} files`, async () => {
        const req = postForm()
          .field('chat_ids', '123')
          .field('message', 'Hello');
        for (let i = 0; i <= MAX_ATTACHMENTS; i++) {
          req.attach('files', Buffer.from('x'), `${i}.txt`);
        }

        const res = await req.expect(400);

        expect(res.body.message).toEqual([
          `files must contain at most ${MAX_ATTACHMENTS} files`,
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('rejects a file in a field other than files', async () => {
        const res = await postForm()
          .field('chat_ids', '123')
          .attach('message', Buffer.from('Hello'), 'message.txt')
          .expect(400);

        expect(res.body.message).toEqual([
          'unexpected file in field "message"; only "files" may contain files',
        ]);
      });

      it('rejects an empty file, which Telegram would refuse', async () => {
        const res = await postForm()
          .field('chat_ids', '123')
          .field('message', 'Hello')
          .attach('files', Buffer.alloc(0), 'errors.log')
          .expect(400);

        expect(res.body.message).toEqual([
          'each file must not be empty ("errors.log" is empty)',
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('rejects a truncated multipart body', async () => {
        const res = await postForm()
          .set('Content-Type', 'multipart/form-data; boundary=xyz')
          .send(
            '--xyz\r\nContent-Disposition: form-data; name="message"\r\n\r\nHel',
          )
          .expect(400);

        expect(res.body.message).toEqual([
          'malformed multipart body: Unexpected end of form',
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  });

  describe('cross-site requests', () => {
    const FORBIDDEN = 'Cross-site requests from web browsers are not allowed';
    const body = { chat_ids: ['123'], message: 'Hello' };

    it.each([
      ['Origin', 'https://evil.example'],
      ['Origin', 'null'],
      ['Sec-Fetch-Site', 'cross-site'],
      ['Sec-Fetch-Site', 'same-site'],
    ])('rejects a JSON request with %s: %s', async (header, value) => {
      const res = await post(body).set(header, value).expect(403);

      expect(res.body.message).toBe(FORBIDDEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a form posted from another site', async () => {
      const res = await postForm()
        .set('Origin', 'https://evil.example')
        .field('chat_ids', '123')
        .field('message', 'Hello')
        .expect(403);

      expect(res.body.message).toBe(FORBIDDEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['Sec-Fetch-Site: same-origin', { 'Sec-Fetch-Site': 'same-origin' }],
      [
        'an Origin that matches the Host',
        {
          Host: 'Telehook.internal:3000',
          Origin: 'http://telehook.internal:3000',
        },
      ],
    ])('accepts a browser request with %s', async (_case, headers) => {
      await post(body).set(headers).expect(200);
    });
  });

  it(`rate limits clients after ${RATE_LIMIT} requests`, async () => {
    const body = { chat_ids: ['123'], message: 'Hello' };
    for (let i = 0; i < RATE_LIMIT; i++) {
      await post(body).expect(200);
    }

    const res = await post(body).expect(429);

    // The window is 60 seconds in vitest.config.e2e.ts.
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(res.body.message).toBe(
      retryAfter === 60
        ? 'Too many requests, please try again in 1 minute'
        : `Too many requests, please try again in ${retryAfter} seconds`,
    );
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
