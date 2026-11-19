import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const AUTH_FAIL_LIMIT_ENV = 'ADMIN_AUTH_FAIL_LIMIT';
export const AUTH_FAIL_WINDOW_ENV = 'ADMIN_AUTH_FAIL_WINDOW_SECONDS';
export const DEFAULT_AUTH_FAIL_LIMIT = 60;
export const DEFAULT_AUTH_FAIL_WINDOW_SECONDS = 60;
export const AUTH_FAIL_MAX_TRACKED_IPS = 10_000;
export const AUTH_FAILURE_CLOCK = Symbol('AUTH_FAILURE_CLOCK');

const WARN_INTERVAL_MS = 60_000;

export interface AuthFailureClock {
  now(): number;
}

interface FailureWindow {
  failures: number;
  resetAt: number;
}

function positiveInteger(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string | number>(key);
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

@Injectable()
export class AuthFailureLimiter {
  private readonly logger = new Logger(AuthFailureLimiter.name);
  private readonly windows = new Map<string, FailureWindow>();
  private readonly limit: number;
  private readonly windowSeconds: number;
  private warnedAt = Number.NEGATIVE_INFINITY;
  private suppressedTrips = 0;

  constructor(
    config: ConfigService,
    @Inject(AUTH_FAILURE_CLOCK) private readonly clock: AuthFailureClock,
  ) {
    this.limit = positiveInteger(
      config,
      AUTH_FAIL_LIMIT_ENV,
      DEFAULT_AUTH_FAIL_LIMIT,
    );
    this.windowSeconds = positiveInteger(
      config,
      AUTH_FAIL_WINDOW_ENV,
      DEFAULT_AUTH_FAIL_WINDOW_SECONDS,
    );
  }

  get trackedIps(): number {
    return this.windows.size;
  }

  retryAfterSeconds(ip: string): number | null {
    const now = this.clock.now();
    this.dropExpired(now);
    const window = this.windows.get(ip);
    if (window === undefined || window.failures < this.limit) {
      return null;
    }
    return Math.max(1, Math.ceil((window.resetAt - now) / 1000));
  }

  recordFailure(ip: string): void {
    const now = this.clock.now();
    this.dropExpired(now);
    let window = this.windows.get(ip);
    if (window === undefined) {
      if (this.windows.size >= AUTH_FAIL_MAX_TRACKED_IPS) {
        this.windows.delete(this.windows.keys().next().value as string);
      }
      window = { failures: 0, resetAt: now + this.windowSeconds * 1000 };
      this.windows.set(ip, window);
    }
    window.failures += 1;
    if (window.failures === this.limit) {
      this.warnTripped(ip, now);
    }
  }

  private dropExpired(now: number): void {
    for (const [ip, window] of this.windows) {
      if (window.resetAt > now) {
        return;
      }
      this.windows.delete(ip);
    }
  }

  private warnTripped(ip: string, now: number): void {
    if (now - this.warnedAt < WARN_INTERVAL_MS) {
      this.suppressedTrips += 1;
      return;
    }
    const suppressed = this.suppressedTrips;
    this.warnedAt = now;
    this.suppressedTrips = 0;
    this.logger.warn(
      `Failed-auth limit reached for ${ip}: ${this.limit} failures in ${this.windowSeconds}s` +
        (suppressed > 0 ? ` (${suppressed} more since the last warning)` : ''),
    );
  }
}
