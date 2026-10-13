import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsString,
  Matches,
  ValidateBy,
} from 'class-validator';

/** Telegram's limit for the text of an ordinary message. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Numeric chat ID: positive for users, negative for groups, -100… for
 * supergroups and channels. Telegram guarantees at most 52 significant bits.
 */
const CHAT_ID_PATTERN = /^-?[1-9]\d{0,15}$/;

// class-validator checks decorators bottom-up and the global ValidationPipe
// stops at the first failure, so type checks sit closest to each property.
export class SendNotificationDto {
  @ArrayUnique({ message: 'chat_ids must not contain duplicates' })
  @Matches(CHAT_ID_PATTERN, {
    each: true,
    message:
      'each chat ID must be a numeric Telegram chat ID such as "123456789" or "-1001234567890"',
  })
  @IsString({ each: true, message: 'each chat ID must be a string' })
  @ArrayNotEmpty({ message: 'chat_ids must contain at least one chat ID' })
  @IsArray({ message: 'chat_ids must be an array of chat ID strings' })
  chat_ids!: string[];

  @MaxUtf16Length(TELEGRAM_MAX_MESSAGE_LENGTH)
  @Matches(/\S/, { message: 'message must not be empty or whitespace only' })
  @IsString({ message: 'message must be a string' })
  message!: string;
}

/**
 * Length limit in UTF-16 code units. @MaxLength counts most emoji as one
 * character, so it would accept text far longer than Telegram allows.
 */
function MaxUtf16Length(max: number): PropertyDecorator {
  return ValidateBy({
    name: 'maxUtf16Length',
    constraints: [max],
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && value.length <= max,
      defaultMessage: () => `$property must be at most ${max} characters long`,
    },
  });
}
