import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import { clientIp, MINUTE_MS } from '../activation/activation-throttler.guard';

export const SIGN_FORMS_READ_LIMIT = { limit: 30, ttl: MINUTE_MS };
export const SIGN_FORMS_COMPLETE_LIMIT = { limit: 10, ttl: MINUTE_MS };

const SIGN_FORMS_THROTTLE_OPTIONS: ThrottlerModuleOptions = {
  throttlers: [{ name: 'default', ...SIGN_FORMS_READ_LIMIT }],
};

class FlyClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(clientIp(req));
  }
}

/** Per-client-IP throttle for the public form signing endpoints, with its own storage. */
@Injectable()
export class SignFormsThrottlerGuard
  implements CanActivate, OnApplicationShutdown
{
  private readonly storage = new ThrottlerStorageService();
  private readonly inner: FlyClientIpThrottlerGuard;
  private readonly ready: Promise<void>;

  constructor(reflector: Reflector) {
    this.inner = new FlyClientIpThrottlerGuard(
      SIGN_FORMS_THROTTLE_OPTIONS,
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
