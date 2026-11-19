import { ConfigService } from '@nestjs/config';
import { FakeClock } from '../../test/helpers/admin-api-tokens-fakes';
import {
  AUTH_FAIL_LIMIT_ENV,
  AUTH_FAIL_MAX_TRACKED_IPS,
  AUTH_FAIL_WINDOW_ENV,
  AuthFailureLimiter,
} from './auth-failure-limiter';

describe('AuthFailureLimiter', () => {
  const clock = new FakeClock();
  const limiter = (env: Record<string, unknown> = {}) =>
    new AuthFailureLimiter(new ConfigService(env), clock);
  const fail = (target: AuthFailureLimiter, ip: string, times: number) => {
    for (let i = 0; i < times; i++) {
      target.recordFailure(ip);
    }
  };

  it('blocks an IP for the rest of the window after 60 failures by default', () => {
    const subject = limiter();
    fail(subject, '192.0.2.1', 59);
    expect(subject.retryAfterSeconds('192.0.2.1')).toBeNull();

    subject.recordFailure('192.0.2.1');
    expect(subject.retryAfterSeconds('192.0.2.1')).toBe(60);

    clock.advance(59_001);
    expect(subject.retryAfterSeconds('192.0.2.1')).toBe(1);
    clock.advance(999);
    expect(subject.retryAfterSeconds('192.0.2.1')).toBeNull();
    expect(subject.trackedIps).toBe(0);
  });

  it('reads the limit and window from the environment', () => {
    const subject = limiter({
      [AUTH_FAIL_LIMIT_ENV]: '3',
      [AUTH_FAIL_WINDOW_ENV]: '300',
    });
    fail(subject, '192.0.2.2', 3);

    expect(subject.retryAfterSeconds('192.0.2.2')).toBe(300);
  });

  it.each([
    [AUTH_FAIL_LIMIT_ENV, '0'],
    [AUTH_FAIL_LIMIT_ENV, 'many'],
    [AUTH_FAIL_WINDOW_ENV, '-5'],
    [AUTH_FAIL_WINDOW_ENV, '1.5'],
  ])('refuses to start with %s=%s', (key, value) => {
    expect(() => limiter({ [key]: value })).toThrow(
      `${key} must be a positive integer`,
    );
  });

  it(`tracks at most ${AUTH_FAIL_MAX_TRACKED_IPS} IPs, evicting the oldest first`, () => {
    const subject = limiter({ [AUTH_FAIL_LIMIT_ENV]: '1' });
    for (let i = 0; i <= AUTH_FAIL_MAX_TRACKED_IPS; i++) {
      subject.recordFailure(`ip-${i}`);
    }

    expect(subject.trackedIps).toBe(AUTH_FAIL_MAX_TRACKED_IPS);
    expect(subject.retryAfterSeconds('ip-0')).toBeNull();
    expect(subject.retryAfterSeconds('ip-1')).not.toBeNull();
    expect(
      subject.retryAfterSeconds(`ip-${AUTH_FAIL_MAX_TRACKED_IPS}`),
    ).not.toBeNull();
  });
});
