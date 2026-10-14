import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { ErrorFileLogger } from './error-file.logger.js';
import { assignRequestId } from './request-context.js';

@Module({
  providers: [ErrorFileLogger],
  exports: [ErrorFileLogger],
})
export class LoggingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(assignRequestId).forRoutes('*');
  }
}
