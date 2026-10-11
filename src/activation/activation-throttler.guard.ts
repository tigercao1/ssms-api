import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

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

/** Throttler guard keyed on the real client IP behind the Fly proxy. */
@Injectable()
export class ActivationThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(clientIp(req as TrackedRequest));
  }
}
