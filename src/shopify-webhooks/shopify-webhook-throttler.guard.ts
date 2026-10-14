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

export const SHOPIFY_WEBHOOK_RATE_LIMIT = { limit: 600, ttl: 60_000 };

export const SHOPIFY_WEBHOOK_THROTTLE_OPTIONS: ThrottlerModuleOptions = {
  throttlers: [{ name: 'default', ...SHOPIFY_WEBHOOK_RATE_LIMIT }],
};

class FlyClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(clientIp(req));
  }
}

@Injectable()
export class ShopifyWebhookThrottlerGuard
  implements CanActivate, OnApplicationShutdown
{
  private readonly storage = new ThrottlerStorageService();
  private readonly inner: FlyClientIpThrottlerGuard;
  private readonly ready: Promise<void>;

  constructor(reflector: Reflector) {
    this.inner = new FlyClientIpThrottlerGuard(
      SHOPIFY_WEBHOOK_THROTTLE_OPTIONS,
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
