import { Injectable } from '@nestjs/common';

/**
 * Per-key fixed-window rate limiter (T7.7).
 *
 * RLS_AND_SECURITY_PLAN.md § Rate limiting locks the public API at
 * **60 req/min/key**, counted on the resolved `api_keys.id` (NOT per IP). v1 is
 * single-instance, so an in-memory fixed-window counter is sufficient and adds
 * zero infra; if the API is ever horizontally scaled, swap this for a shared
 * store (Redis) behind the same interface.
 *
 * Fixed window: each key gets `limit` requests per 60s window; the window
 * resets on the first request after it elapses.
 */
@Injectable()
export class ApiKeyRateLimiter {
  private readonly windowMs = 60_000;
  private readonly buckets = new Map<
    string,
    { count: number; resetAt: number }
  >();

  /**
   * Record one request for `keyId`. Returns `true` if it is within `limit` for
   * the current window, `false` if the limit is exceeded (→ caller responds 429).
   */
  consume(keyId: string, limit: number, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(keyId);
    if (bucket === undefined || now >= bucket.resetAt) {
      this.buckets.set(keyId, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  /** Test/maintenance helper: clear all counters. */
  reset(): void {
    this.buckets.clear();
  }
}
