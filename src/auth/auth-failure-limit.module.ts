import { Global, Module } from '@nestjs/common';
import { AUTH_FAILURE_CLOCK, AuthFailureLimiter } from './auth-failure-limiter';

@Global()
@Module({
  providers: [
    { provide: AUTH_FAILURE_CLOCK, useValue: { now: () => Date.now() } },
    AuthFailureLimiter,
  ],
  exports: [AuthFailureLimiter],
})
export class AuthFailureLimitModule {}
