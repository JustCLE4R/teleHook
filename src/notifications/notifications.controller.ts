import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { SendNotificationDto } from './dto/send-notification.dto.js';
import {
  type DeliverySummary,
  NotificationsService,
} from './notifications.service.js';

export interface SendNotificationResponse {
  success: boolean;
  message: string;
  data: DeliverySummary;
}

@Controller('api')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Responds 200 when every message was delivered, or 207 Multi-Status when at
   * least one failed; `data.results` holds the outcome for each chat.
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  async send(
    @Body() dto: SendNotificationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SendNotificationResponse> {
    const summary = await this.notificationsService.send(
      dto.chat_ids,
      dto.message,
    );
    const success = summary.failed === 0;
    if (!success) {
      res.status(HttpStatus.MULTI_STATUS);
    }
    return {
      success,
      message: success
        ? 'Notification processing completed'
        : 'Notification processing completed with failures',
      data: summary,
    };
  }
}
