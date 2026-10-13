import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { toAttachment } from './attachment.js';
import { SendNotificationDto } from './dto/send-notification.dto.js';
import { MultipartFormInterceptor } from './multipart-form.interceptor.js';
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
   * Accepts a JSON body, or a multipart/form-data body that may also carry
   * files to send after the message.
   *
   * Responds 200 when every chat received everything, or 207 Multi-Status
   * when at least one delivery failed; `data.results` holds the outcome for
   * each chat.
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(MultipartFormInterceptor)
  async send(
    @Body() dto: SendNotificationDto,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SendNotificationResponse> {
    const attachments = (files ?? []).map((file, index) =>
      toAttachment(file, index),
    );
    const summary = await this.notificationsService.send(
      dto.chat_ids,
      dto.message,
      attachments,
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
