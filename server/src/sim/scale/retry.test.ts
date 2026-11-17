import { describe, expect, it } from 'vitest';
import { decide, MAX_ATTEMPTS, parseRetryAfter } from './retry.js';

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-17T10:00:00Z');

  it('reads delta-seconds', () => {
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter(['2'], now)).toBe(2000);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Tue, 17 Nov 2026 10:00:07 GMT', now)).toBe(7000);
    expect(parseRetryAfter('Tue, 17 Nov 2026 09:59:00 GMT', now)).toBe(0);
  });

  it('caps long waits and ignores junk', () => {
    expect(parseRetryAfter('3600', now)).toBe(60_000);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
  });
});

describe('decide', () => {
  it('accepts 2xx', () => {
    expect(decide(200, undefined, 1)).toEqual({ action: 'accepted' });
  });

  it('retries 429 after Retry-After', () => {
    expect(decide(429, '3', 1)).toEqual({ action: 'retry', delayMs: 3000 });
    expect(decide(503, '1', 2)).toEqual({ action: 'retry', delayMs: 1000 });
  });

  it('backs off exponentially without a hint and on network errors', () => {
    expect(decide(429, undefined, 1)).toEqual({ action: 'retry', delayMs: 500 });
    expect(decide(null, undefined, 3)).toEqual({ action: 'retry', delayMs: 2000 });
  });

  it('drops permanent failures and gives up eventually', () => {
    expect(decide(400, undefined, 1).action).toBe('drop');
    expect(decide(413, '5', 1).action).toBe('drop');
    expect(decide(429, '1', MAX_ATTEMPTS).action).toBe('drop');
  });
});
