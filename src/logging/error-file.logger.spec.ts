import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { MockInstance } from 'vitest';
import type { Request, Response } from 'express';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { type ErrorLogEntry, ErrorFileLogger } from './error-file.logger.js';
import { assignRequestId } from './request-context.js';

const TODAY = '2026-10-15';

describe('ErrorFileLogger', () => {
  let dir: string;
  let stderr: MockInstance<typeof process.stderr.write>;

  function createLogger(
    overrides: Partial<EnvironmentVariables> = {},
  ): ErrorFileLogger {
    const values: Partial<EnvironmentVariables> = {
      ERROR_LOG_DIR: dir,
      ERROR_LOG_RETENTION_DAYS: 30,
      ...overrides,
    };
    const config = { get: (key: keyof EnvironmentVariables) => values[key] };
    return new ErrorFileLogger(
      config as unknown as ConfigService<EnvironmentVariables, true>,
    );
  }

  async function entries(
    logger: ErrorFileLogger,
    day = TODAY,
  ): Promise<ErrorLogEntry[]> {
    await logger.onApplicationShutdown();
    return readFileSync(join(dir, `errors-${day}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ErrorLogEntry);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'telehook-logs-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T08:30:00Z`));
    // Keep the console output of the tests clean.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends warnings and errors as JSON lines, but nothing else', async () => {
    const logger = createLogger();

    logger.log('Listening on port 3000', 'Bootstrap');
    logger.warn('Request to Telegram failed: ECONNRESET', 'TelegramService');
    logger.error(
      'Unexpected error while delivering to chat 123',
      'Error: boom\n    at deliver (notifications.service.ts:1:1)',
      'NotificationsService',
    );

    await expect(entries(logger)).resolves.toEqual([
      {
        time: '2026-10-15T08:30:00.000Z',
        level: 'warn',
        context: 'TelegramService',
        message: 'Request to Telegram failed: ECONNRESET',
      },
      {
        time: '2026-10-15T08:30:00.000Z',
        level: 'error',
        context: 'NotificationsService',
        message: 'Unexpected error while delivering to chat 123',
        stack: 'Error: boom\n    at deliver (notifications.service.ts:1:1)',
      },
    ]);
  });

  it('records the message and stack of an Error', async () => {
    const logger = createLogger();
    const error = new Error('Cannot read properties of undefined');

    logger.error(error, 'ExceptionsHandler');

    const [entry] = await entries(logger);
    expect(entry).toMatchObject({
      context: 'ExceptionsHandler',
      message: 'Cannot read properties of undefined',
      stack: error.stack,
    });
  });

  it('records the ID of the request being handled', async () => {
    const logger = createLogger();
    const req = { get: () => 'alert-42' } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;

    assignRequestId(req, res, () => logger.warn('Delivery failed', 'Test'));

    const [entry] = await entries(logger);
    expect(entry.request_id).toBe('alert-42');
  });

  it('starts a new file each day (UTC)', async () => {
    const logger = createLogger();

    logger.warn('first', 'Test');
    vi.setSystemTime(new Date('2026-10-16T00:00:01Z'));
    logger.warn('second', 'Test');
    await logger.onApplicationShutdown();

    expect(readdirSync(dir).sort()).toEqual([
      'errors-2026-10-15.jsonl',
      'errors-2026-10-16.jsonl',
    ]);
  });

  it('deletes files older than the retention period', async () => {
    for (const name of [
      'errors-2026-09-14.jsonl', // 31 days old
      'errors-2026-09-15.jsonl', // 30 days old: its last day is in the window
      'notes.txt',
    ]) {
      writeFileSync(join(dir, name), '');
    }
    const logger = createLogger();

    logger.warn('Delivery failed', 'Test');
    await logger.onApplicationShutdown();

    expect(readdirSync(dir).sort()).toEqual([
      'errors-2026-09-15.jsonl',
      'errors-2026-10-15.jsonl',
      'notes.txt',
    ]);
  });

  it('writes no file when ERROR_LOG_DIR is empty', async () => {
    rmSync(dir, { recursive: true });
    const logger = createLogger({ ERROR_LOG_DIR: '' });

    logger.error('Something failed', 'Test');
    await logger.onApplicationShutdown();

    expect(existsSync(dir)).toBe(false);
  });

  it('reports a file it cannot write once, on stderr, and keeps running', async () => {
    // A file where the directory should be.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, '');
    const logger = createLogger({ ERROR_LOG_DIR: blocked });

    logger.error('first', 'Test');
    logger.error('second', 'Test');
    await logger.onApplicationShutdown();

    const reports = stderr.mock.calls.filter(([text]) =>
      String(text).startsWith('Could not write the error log'),
    );
    expect(reports).toHaveLength(1);
  });
});
