import {
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
    consumer.apply(requireJsonBody).forRoutes(NotificationsController);
  }
}

/**
 * Rejects bodies that are not JSON. HTML forms can post urlencoded bodies
 * cross-site without a CORS preflight, which would let any web page send
 * messages through an instance reachable from the visitor's browser.
 */
function requireJsonBody(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  // null means there is no body at all; validation rejects that with a 400.
  if (req.is('application/json') === false) {
    throw new UnsupportedMediaTypeException(
      'Content-Type must be application/json',
    );
  }
  next();
}
