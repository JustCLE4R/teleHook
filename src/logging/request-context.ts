import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Accepted from a caller or proxy; anything else could forge log content. */
const REQUEST_ID_PATTERN = /^[\w.-]{1,64}$/;

const storage = new AsyncLocalStorage<{ requestId: string }>();

/**
 * Gives each request an ID, available to everything that runs for it, so the
 * log lines of one request can be grouped. A valid X-Request-Id header from
 * the caller is kept, which links our logs to theirs. The ID is returned in
 * the X-Request-Id response header.
 */
export function assignRequestId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.get('X-Request-Id');
  const requestId =
    incoming !== undefined && REQUEST_ID_PATTERN.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  storage.run({ requestId }, next);
}

/** The ID of the request being handled, if any. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
