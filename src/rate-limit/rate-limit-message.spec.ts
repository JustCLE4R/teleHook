import { rateLimitMessage } from './rate-limit-message.js';

describe('rateLimitMessage', () => {
  it.each([
    [1, 'Too many requests, please try again in 1 second'],
    [42, 'Too many requests, please try again in 42 seconds'],
    [60, 'Too many requests, please try again in 1 minute'],
    [65, 'Too many requests, please try again in 1 minute 5 seconds'],
    [121, 'Too many requests, please try again in 2 minutes 1 second'],
    // Never tells the client to retry immediately.
    [0, 'Too many requests, please try again in 1 second'],
    [2.2, 'Too many requests, please try again in 3 seconds'],
  ])('describes a wait of %d seconds', (seconds, message) => {
    expect(rateLimitMessage(seconds)).toBe(message);
  });
});
