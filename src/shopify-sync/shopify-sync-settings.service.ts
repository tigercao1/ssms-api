import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readShopifyConfig } from '../shopify/shopify.config';
import { ShopifyConfigError } from '../shopify/shopify.errors';
import {
  type ShopifySyncHeartbeat,
  ShopifySyncSettingsRepository,
} from './shopify-sync-settings.repository';

export const SETTINGS_CACHE_MS = 5_000;

export function isMasterSwitchOn(config: ConfigService): boolean {
  return config.get<string>('SHOPIFY_SYNC_ENABLED')?.trim() === 'true';
}

export function isShopifyConfigured(config: ConfigService): boolean {
  try {
    readShopifyConfig((key) => config.get<string>(key));
    return true;
  } catch (err) {
    if (err instanceof ShopifyConfigError) {
      return false;
    }
    throw err;
  }
}

@Injectable()
export class ShopifySyncSettings {
  private readonly logger = new Logger(ShopifySyncSettings.name);
  private cached?: { enabled: boolean; readAt: number };

  constructor(private readonly repo: ShopifySyncSettingsRepository) {}

  async isEnabled(): Promise<boolean> {
    if (this.cached && Date.now() - this.cached.readAt < SETTINGS_CACHE_MS) {
      return this.cached.enabled;
    }
    const settings = await this.repo.getSettings();
    this.remember(settings?.enabled ?? false);
    return settings?.enabled ?? false;
  }

  remember(enabled: boolean): void {
    this.cached = { enabled, readAt: Date.now() };
  }

  recordTick(): Promise<void> {
    return this.heartbeat({ last_tick_at: new Date().toISOString() });
  }

  recordSuccess(): Promise<void> {
    return this.heartbeat({ last_success_at: new Date().toISOString() });
  }

  recordError(message: string): Promise<void> {
    return this.heartbeat({
      last_error: message,
      last_error_at: new Date().toISOString(),
    });
  }

  private async heartbeat(heartbeat: ShopifySyncHeartbeat): Promise<void> {
    try {
      await this.repo.recordHeartbeat(heartbeat);
    } catch (err) {
      this.logger.error(
        `Could not record Shopify sync heartbeat: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
