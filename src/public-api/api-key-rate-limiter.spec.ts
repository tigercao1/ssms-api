import { ApiKeyRateLimiter } from './api-key-rate-limiter';

describe('ApiKeyRateLimiter', () => {
  let limiter: ApiKeyRateLimiter;

  beforeEach(() => {
    limiter = new ApiKeyRateLimiter();
  });

  it('allows up to `limit` requests within the window', () => {
    const t = 1_000;
    for (let i = 0; i < 3; i++) {
      expect(limiter.consume('key-1', 3, t)).toBe(true);
    }
  });

  it('blocks the request that exceeds the limit', () => {
    const t = 1_000;
    expect(limiter.consume('key-1', 2, t)).toBe(true);
    expect(limiter.consume('key-1', 2, t)).toBe(true);
    expect(limiter.consume('key-1', 2, t)).toBe(false);
  });

  it('resets after the 60s window elapses', () => {
    expect(limiter.consume('key-1', 1, 0)).toBe(true);
    expect(limiter.consume('key-1', 1, 30_000)).toBe(false);
    // Window boundary at 60_000ms -> fresh allowance.
    expect(limiter.consume('key-1', 1, 60_000)).toBe(true);
  });

  it('tracks each key independently', () => {
    expect(limiter.consume('key-a', 1, 0)).toBe(true);
    expect(limiter.consume('key-a', 1, 0)).toBe(false);
    // A different key is unaffected.
    expect(limiter.consume('key-b', 1, 0)).toBe(true);
  });

  it('reset() clears all counters', () => {
    expect(limiter.consume('key-a', 1, 0)).toBe(true);
    limiter.reset();
    expect(limiter.consume('key-a', 1, 0)).toBe(true);
  });
});
