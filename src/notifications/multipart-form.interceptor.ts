import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import type { Observable } from 'rxjs';
import type { EnvironmentVariables } from '../config/env.validation.js';

/** The multipart field that carries attachments. */
export const FILES_FIELD = 'files';

/**
 * Limits for the text fields. A valid request has one message field and at
 * most one chat_ids field per recipient, well within both.
 */
const MAX_TEXT_FIELDS = 200;
const MAX_TEXT_FIELD_BYTES = 64 * 1024;

/**
 * Parses multipart/form-data bodies into the same shape as JSON ones, so both
 * go through the same validation, and puts the uploaded files in `req.files`.
 * Other requests pass through untouched.
 */
@Injectable()
export class MultipartFormInterceptor implements NestInterceptor {
  private readonly maxFiles: number;
  private readonly maxFileSizeMb: number;
  private readonly parse: RequestHandler;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.maxFiles = config.get('MAX_ATTACHMENTS_PER_REQUEST', { infer: true });
    this.maxFileSizeMb = config.get('MAX_ATTACHMENT_SIZE_MB', { infer: true });
    this.parse = multer({
      // Uploads are held in memory, bounded by the limits below.
      storage: multer.memoryStorage(),
      // curl, browsers and HTTP libraries send file names as UTF-8.
      defParamCharset: 'utf8',
      limits: {
        files: this.maxFiles,
        fileSize: this.maxFileSizeMb * 1024 * 1024,
        fields: MAX_TEXT_FIELDS,
        fieldSize: MAX_TEXT_FIELD_BYTES,
        // Allows chat_ids[] and chat_ids[0]. An index beyond the field limit
        // could only create a sparse array.
        fieldNestingDepth: 1,
        fieldArrayIndexLimit: MAX_TEXT_FIELDS,
      },
    }).array(FILES_FIELD);
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    if (!req.is('multipart/form-data')) {
      return next.handle();
    }

    await new Promise<void>((resolve, reject) => {
      this.parse(req, http.getResponse(), (error?: unknown) => {
        if (error) {
          reject(this.toHttpException(error));
        } else {
          resolve();
        }
      });
    });
    checkUploads(req);
    normalizeChatIds(req.body);
    return next.handle();
  }

  private toHttpException(error: unknown): unknown {
    if (!(error instanceof multer.MulterError)) {
      // busboy rejects a malformed body with a plain Error, such as
      // "Unexpected end of form".
      return error instanceof Error
        ? new BadRequestException([
            `malformed multipart body: ${error.message}`,
          ])
        : error;
    }
    switch (error.code) {
      case 'LIMIT_FILE_SIZE': {
        // multer names the file, although its type definitions omit it.
        const { filename } = error as { filename?: string };
        const offender =
          filename === undefined ? '' : ` ("${filename}" is larger)`;
        return new PayloadTooLargeException(
          `each file must be at most ${this.maxFileSizeMb} MB${offender}`,
        );
      }
      case 'LIMIT_FILE_COUNT':
        return new BadRequestException([
          `${FILES_FIELD} must contain at most ${this.maxFiles} files`,
        ]);
      case 'LIMIT_UNEXPECTED_FILE':
        return new BadRequestException([
          `unexpected file in field "${error.field}"; only "${FILES_FIELD}" may contain files`,
        ]);
      default:
        return new BadRequestException([
          error.field === undefined
            ? error.message
            : `${error.message}: ${error.field}`,
        ]);
    }
  }
}

function checkUploads(req: Request): void {
  // For example `curl -F files=report.txt`, which sends the name, not the file.
  if (Object.hasOwn(req.body, FILES_FIELD)) {
    throw new BadRequestException([
      `${FILES_FIELD} must be file uploads, not text fields`,
    ]);
  }
  const files = Array.isArray(req.files) ? req.files : [];
  // Telegram refuses empty files.
  const empty = files.find((file) => file.size === 0);
  if (empty) {
    throw new BadRequestException([
      `each file must not be empty ("${empty.originalname}" is empty)`,
    ]);
  }
}

/**
 * A form sends one field per value, so a single chat ID arrives as a string
 * and several as an array. A field may also hold a comma-separated list,
 * which is easier to pass from a shell variable.
 */
function normalizeChatIds(body: Record<string, unknown>): void {
  const value = body.chat_ids;
  if (typeof value !== 'string' && !Array.isArray(value)) {
    // Missing or malformed; validation reports it.
    return;
  }
  // Array.from turns the gaps of a sparse array, from a field such as
  // chat_ids[5], into undefined values, which validation rejects.
  const values: unknown[] =
    typeof value === 'string' ? [value] : Array.from(value);
  body.chat_ids = values.flatMap((item) =>
    typeof item === 'string' ? item.split(',').map((id) => id.trim()) : [item],
  );
}
