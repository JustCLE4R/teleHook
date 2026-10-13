import { validateEnv } from './env.validation.js';

const TOKEN = '123456789:AAH-valid_token';

describe('validateEnv', () => {
  it('applies defaults and converts numeric strings', () => {
    expect(
      validateEnv({ TELEGRAM_BOT_TOKEN: TOKEN, PORT: '8080' }),
    ).toMatchObject({
      PORT: 8080,
      TELEGRAM_BOT_TOKEN: TOKEN,
      MAX_RECIPIENTS_PER_REQUEST: 20,
      TELEGRAM_REQUEST_TIMEOUT_MS: 10_000,
      RATE_LIMIT_TTL_MS: 60_000,
      RATE_LIMIT_MAX_REQUESTS: 10,
    });
  });

  it('rejects a missing bot token', () => {
    expect(() => validateEnv({})).toThrow('TELEGRAM_BOT_TOKEN must be set');
  });

  it.each([
    '',
    'your_telegram_bot_token',
    '123456789',
    'abc:def',
    '123:abc/def',
    '123: abc',
  ])('rejects the malformed bot token %j', (token) => {
    expect(() => validateEnv({ TELEGRAM_BOT_TOKEN: token })).toThrow(
      'TELEGRAM_BOT_TOKEN must be set',
    );
  });

  it('does not echo the bot token in the error', () => {
    expect(() =>
      validateEnv({ TELEGRAM_BOT_TOKEN: '123456789:leaked/secret' }),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('leaked'),
      }),
    );
  });

  it.each([
    ['MAX_RECIPIENTS_PER_REQUEST', '0'],
    ['MAX_RECIPIENTS_PER_REQUEST', '101'],
    ['MAX_RECIPIENTS_PER_REQUEST', 'twenty'],
    ['PORT', '70000'],
    ['TELEGRAM_REQUEST_TIMEOUT_MS', '10'],
    ['RATE_LIMIT_MAX_REQUESTS', '0'],
  ])('rejects %s=%j', (name, value) => {
    expect(() =>
      validateEnv({ TELEGRAM_BOT_TOKEN: TOKEN, [name]: value }),
    ).toThrow(name);
  });
});
