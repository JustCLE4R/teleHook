/**
 * The 429 message, with the same wait as the Retry-After header, e.g.
 * "Too many requests, please try again in 1 minute 5 seconds".
 */
export function rateLimitMessage(waitSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(waitSeconds));
  const minutes = Math.floor(seconds / 60);
  const parts = [
    minutes > 0 ? plural(minutes, 'minute') : '',
    seconds % 60 > 0 ? plural(seconds % 60, 'second') : '',
  ].filter(Boolean);
  return `Too many requests, please try again in ${parts.join(' ')}`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
