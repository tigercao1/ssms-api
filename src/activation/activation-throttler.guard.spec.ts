import { Reflector } from '@nestjs/core';
import { ThrottlerStorageService } from '@nestjs/throttler';
import {
  ActivationThrottlerGuard,
  clientIp,
  emailTracker,
} from './activation-throttler.guard';

describe('activation throttler trackers', () => {
  it('prefers the Fly-Client-IP header', () => {
    expect(
      clientIp({ ip: '10.0.0.1', headers: { 'fly-client-ip': ' 1.2.3.4 ' } }),
    ).toBe('1.2.3.4');
    expect(
      clientIp({ ip: '10.0.0.1', headers: { 'fly-client-ip': ['5.6.7.8'] } }),
    ).toBe('5.6.7.8');
  });

  it('falls back to the socket address, then a constant', () => {
    expect(clientIp({ ip: '10.0.0.1', headers: {} })).toBe('10.0.0.1');
    expect(clientIp({})).toBe('unknown');
  });

  it('buckets resend by lowercased email, else by IP', () => {
    expect(emailTracker({ body: { email: ' Jane@Example.TEST ' } })).toBe(
      'email:jane@example.test',
    );
    expect(emailTracker({ ip: '10.0.0.1', body: { email: ' ' } })).toBe(
      'ip:10.0.0.1',
    );
    expect(emailTracker({ ip: '10.0.0.1' })).toBe('ip:10.0.0.1');
  });
});

describe('ActivationThrottlerGuard', () => {
  it('clears its own storage timers on shutdown', () => {
    const spy = jest.spyOn(
      ThrottlerStorageService.prototype,
      'onApplicationShutdown',
    );
    new ActivationThrottlerGuard(new Reflector()).onApplicationShutdown();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
