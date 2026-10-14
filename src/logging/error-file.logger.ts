import { createWriteStream, mkdirSync, readdirSync, rmSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ConsoleLogger,
  Injectable,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { currentRequestId } from './request-context.js';

const FILE_PATTERN = /^errors-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One line of an error log file. */
export interface ErrorLogEntry {
  time: string;
  level: 'warn' | 'error';
  context?: string;
  request_id?: string;
  message: string;
  stack?: string;
}

/**
 * Logs to the console like Nest's default logger, and also appends warnings
 * and errors to a daily file, errors-YYYY-MM-DD.jsonl (UTC), one JSON object
 * per line. Files older than the retention period are deleted.
 *
 * Writing the file never fails the app: problems are reported on stderr.
 */
@Injectable()
export class ErrorFileLogger
  extends ConsoleLogger
  implements OnApplicationShutdown
{
  private readonly dir: string | undefined;
  private readonly retentionDays: number;
  private stream: WriteStream | undefined;
  private streamDay: string | undefined;
  private failed = false;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    super();
    const dir = config.get('ERROR_LOG_DIR', { infer: true });
    this.dir = dir === '' ? undefined : resolve(dir);
    this.retentionDays = config.get('ERROR_LOG_RETENTION_DAYS', {
      infer: true,
    });
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(message, ...optionalParams);
    this.record('warn', message, optionalParams);
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(message, ...optionalParams);
    this.record('error', message, optionalParams);
  }

  /** Resolves once every line written so far is on disk. */
  async onApplicationShutdown(): Promise<void> {
    const stream = this.stream;
    this.stream = undefined;
    this.streamDay = undefined;
    if (stream) {
      await new Promise<void>((done) => stream.end(done));
    }
  }

  private record(
    level: ErrorLogEntry['level'],
    message: unknown,
    params: unknown[],
  ): void {
    if (this.dir === undefined) {
      return;
    }
    // Nest passes the context last, after the stack for errors.
    const last = params.at(-1);
    const context =
      typeof last === 'string' && !this.isStackFormat(last) ? last : undefined;
    let stack = params.find(
      (param): param is string =>
        typeof param === 'string' && this.isStackFormat(param),
    );
    let text: string;
    if (message instanceof Error) {
      text = message.message;
      stack ??= message.stack;
    } else {
      text = typeof message === 'string' ? message : JSON.stringify(message);
    }

    const now = new Date();
    const entry: ErrorLogEntry = {
      time: now.toISOString(),
      level,
      context,
      request_id: currentRequestId(),
      message: text,
      stack,
    };
    this.streamFor(now)?.write(`${JSON.stringify(entry)}\n`);
  }

  private streamFor(now: Date): WriteStream | undefined {
    const day = now.toISOString().slice(0, 10);
    if (this.streamDay === day && this.stream) {
      return this.stream;
    }
    this.stream?.end();
    this.stream = undefined;
    this.streamDay = day;
    try {
      mkdirSync(this.dir!, { recursive: true });
      this.removeExpiredFiles(now);
      const stream = createWriteStream(join(this.dir!, `errors-${day}.jsonl`), {
        flags: 'a',
      });
      stream.on('error', (error) => this.reportFailure(error));
      this.stream = stream;
    } catch (error) {
      this.reportFailure(error);
    }
    return this.stream;
  }

  private removeExpiredFiles(now: Date): void {
    const cutoff = now.getTime() - this.retentionDays * DAY_MS;
    for (const name of readdirSync(this.dir!)) {
      const day = FILE_PATTERN.exec(name)?.[1];
      // A file is kept for the whole of its last day.
      if (day !== undefined && Date.parse(day) + DAY_MS <= cutoff) {
        rmSync(join(this.dir!, name), { force: true });
      }
    }
  }

  /** Reported once on stderr; going through error() would loop. */
  private reportFailure(error: unknown): void {
    if (!this.failed) {
      this.failed = true;
      process.stderr.write(
        `Could not write the error log in ${this.dir}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
