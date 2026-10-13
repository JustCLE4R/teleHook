import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup.ts'],
    // Fixed configuration for the e2e suite. Environment variables take
    // precedence over a local .env file, so these values override it.
    env: {
      TELEGRAM_BOT_TOKEN: '123456789:e2e-test-token',
      MAX_RECIPIENTS_PER_REQUEST: '20',
      TELEGRAM_REQUEST_TIMEOUT_MS: '1000',
      RATE_LIMIT_TTL_MS: '60000',
      RATE_LIMIT_MAX_REQUESTS: '5',
    },
  },
});
