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
import { clientIp } from '../activation/activation-throttler.guard';

export const HOOK_RATE_LIMIT = { limit: 120, ttl: 60_000 };

export const HOOK_THROTTLE_OPTIONS: ThrottlerModuleOptions = {
  throttlers: [{ name: 'default', ...HOOK_RATE_LIMIT }],
};

class FlyClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(clientIp(req));
  }
}

/**
 * 120 calls a minute per client IP (`Fly-Client-IP` behind the Fly proxy) for
 * the Supabase hook routes. Owns its options and storage, like the activation
 * guard, so it needs no app-wide `ThrottlerModule`.
 */
@Injectable()
export class HookThrottlerGuard implements CanActivate, OnApplicationShutdown {
  private readonly storage = new ThrottlerStorageService();
  private readonly inner: FlyClientIpThrottlerGuard;
  private readonly ready: Promise<void>;

  constructor(reflector: Reflector) {
    this.inner = new FlyClientIpThrottlerGuard(
      HOOK_THROTTLE_OPTIONS,
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
