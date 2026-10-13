import {
  ForbiddenException,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TelegramModule } from '../telegram/telegram.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [TelegramModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(rejectCrossSiteRequests, requireSupportedBody)
      .forRoutes(NotificationsController);
  }
}

/**
 * Rejects requests that a web browser sends on behalf of another site. HTML
 * forms can post multipart bodies cross-site without a CORS preflight, which
 * would let any web page send messages through an instance reachable from
 * the visitor's browser. curl and server-side HTTP clients send neither of
 * the headers checked here.
 */
function rejectCrossSiteRequests(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const site = req.get('Sec-Fetch-Site');
  // Browsers send Sec-Fetch-Site only over HTTPS and to localhost. Otherwise
  // they still send Origin with every POST.
  const allowed =
    site === undefined
      ? isSameOrigin(req.get('Origin'), req.get('Host'))
      : site === 'same-origin' || site === 'none';
  if (!allowed) {
    throw new ForbiddenException(
      'Cross-site requests from web browsers are not allowed',
    );
  }
  next();
}

function isSameOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined) {
    return true;
  }
  // URL.canParse rejects "null", the Origin that browsers send from sandboxed
  // and privacy-sensitive contexts.
  return URL.canParse(origin) && new URL(origin).host === host?.toLowerCase();
}

/**
 * Accepts JSON, or multipart/form-data for messages with files. Other bodies,
 * such as urlencoded forms, are rejected.
 */
function requireSupportedBody(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  // null means there is no body at all; validation rejects that with a 400.
  if (req.is(['application/json', 'multipart/form-data']) === false) {
    throw new UnsupportedMediaTypeException(
      'Content-Type must be application/json or multipart/form-data',
    );
  }
  next();
}
