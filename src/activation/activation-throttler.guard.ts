import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  ThrottlerStorageService,
  throttlerMessage,
} from '@nestjs/throttler';

export const IP_THROTTLER = 'ip';
export const EMAIL_THROTTLER = 'email';
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

interface TrackedRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** Client IP: Fly's `Fly-Client-IP` header when present, else the socket address. */
export function clientIp(req: TrackedRequest): string {
  const fly = req.headers?.['fly-client-ip'];
  const value = Array.isArray(fly) ? fly[0] : fly;
  return value?.trim() || req.ip || 'unknown';
}

/** Per-email bucket for resend; falls back to the IP when no email is sent. */
export function emailTracker(req: TrackedRequest): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() !== ''
    ? `email:${email.trim().toLowerCase()}`
    : `ip:${clientIp(req)}`;
}

/** 10/min per IP by default (resend narrows it to 3/hour) and 3/hour per email. */
export const ACTIVATION_THROTTLE_OPTIONS: ThrottlerModuleOptions = {
  throttlers: [
    { name: IP_THROTTLER, ttl: MINUTE_MS, limit: 10 },
    { name: EMAIL_THROTTLER, ttl: HOUR_MS, limit: 3, getTracker: emailTracker },
  ],
};

class FlyClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(clientIp(req as TrackedRequest));
  }

  protected throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: throttlerMessage,
        retryAfterSeconds: detail.timeToBlockExpire,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Throttler guard keyed on the real client IP behind the Fly proxy. It owns
 * its options and storage, so it does not depend on (or clash with) any
 * app-wide `ThrottlerModule.forRoot`.
 */
@Injectable()
export class ActivationThrottlerGuard
  implements CanActivate, OnApplicationShutdown
{
  private readonly storage = new ThrottlerStorageService();
  private readonly inner: FlyClientIpThrottlerGuard;
  private readonly ready: Promise<void>;

  constructor(reflector: Reflector) {
    this.inner = new FlyClientIpThrottlerGuard(
      ACTIVATION_THROTTLE_OPTIONS,
      this.storage,
      reflector,
    );
    this.ready = this.inner.onModuleInit();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.ready;
    return this.inner.canActivate(context);
  }

  onApplicationShutdown(): void {
    this.storage.onApplicationShutdown();
  }
}
