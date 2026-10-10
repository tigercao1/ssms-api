import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { InstructorSyncRepository } from './instructor-sync.repository';
import { InstructorSyncService } from './instructor-sync.service';
import type { InstructorShopifyState } from './instructor-sync.types';
import { ShopifySyncSettingsRepository } from './shopify-sync-settings.repository';
import {
  isMasterSwitchOn,
  isShopifyConfigured,
  ShopifySyncSettings,
} from './shopify-sync-settings.service';
import { MAX_SYNC_ATTEMPTS } from './shopify-sync.worker';

export const DEFAULT_STOREFRONT_PREVIEW_BASE_URL =
  'https://ssnow.club/pages/our-team-preview/';

export interface ShopifySyncStatus {
  enabled: boolean;
  masterSwitch: boolean;
  configured: boolean;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  queue: {
    pending: number;
    retrying: number;
    oldestEnqueuedAt: string | null;
  };
  entries: {
    synced: number;
    active: number;
    draft: number;
    failed: number;
  };
  storefrontPreviewBaseUrl: string;
}

export interface ShopifySyncRunResult {
  enqueued: number;
  processing: boolean;
}

export type InstructorShopifyEntryStatus = 'active' | 'draft';

export interface InstructorShopifySyncStatus {
  handle: string | null;
  metaobjectId: string | null;
  status: InstructorShopifyEntryStatus | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  queued: boolean;
  attempts: number;
  previewUrl: string | null;
}

@Injectable()
export class ShopifySyncAdminService {
  constructor(
    private readonly config: ConfigService,
    private readonly settingsRepo: ShopifySyncSettingsRepository,
    private readonly syncRepo: InstructorSyncRepository,
    private readonly sync: InstructorSyncService,
    private readonly settings: ShopifySyncSettings,
    private readonly audit: AuditService,
  ) {}

  async status(): Promise<ShopifySyncStatus> {
    const [settings, stats] = await Promise.all([
      this.settingsRepo.getSettings(),
      this.settingsRepo.stats(MAX_SYNC_ATTEMPTS),
    ]);
    return {
      enabled: settings?.enabled ?? false,
      masterSwitch: isMasterSwitchOn(this.config),
      configured: isShopifyConfigured(this.config),
      lastTickAt: settings?.last_tick_at ?? null,
      lastSuccessAt: settings?.last_success_at ?? null,
      lastError: settings?.last_error ?? null,
      lastErrorAt: settings?.last_error_at ?? null,
      queue: {
        pending: stats.pending,
        retrying: stats.retrying,
        oldestEnqueuedAt: stats.oldestEnqueuedAt,
      },
      entries: {
        synced: stats.synced,
        active: stats.active,
        draft: stats.draft,
        failed: stats.failed,
      },
      storefrontPreviewBaseUrl: this.previewBaseUrl(),
    };
  }

  async setEnabled(
    enabled: boolean,
    actor: AuditActor,
  ): Promise<ShopifySyncStatus> {
    const before = await this.settingsRepo.getSettings();
    await this.settingsRepo.setEnabled(enabled, actor.userId ?? null);
    this.settings.remember(enabled);
    await this.audit.record({
      action: enabled
        ? AUDIT_ACTIONS.shopifySyncEnable
        : AUDIT_ACTIONS.shopifySyncDisable,
      actor: { ...actor, role: 'admin' },
      metadata: { from: before?.enabled ?? false, to: enabled },
    });
    return this.status();
  }

  async run(
    instructorId: string | undefined,
    actor: AuditActor,
  ): Promise<ShopifySyncRunResult> {
    let enqueued: number;
    if (instructorId) {
      await this.knownInstructorState(instructorId);
      await this.settingsRepo.enqueueInstructor(instructorId);
      enqueued = 1;
    } else {
      enqueued = (await this.sync.reconcile()).enqueued;
    }
    const processing = await this.isProcessing();
    await this.audit.record({
      action: AUDIT_ACTIONS.shopifySyncRun,
      actor: { ...actor, role: 'admin' },
      targetType: instructorId ? 'instructor' : null,
      targetId: instructorId ?? null,
      metadata: { scope: instructorId ? 'instructor' : 'all', enqueued },
    });
    return { enqueued, processing };
  }

  async instructor(instructorId: string): Promise<InstructorShopifySyncStatus> {
    const [state, queued] = await Promise.all([
      this.knownInstructorState(instructorId),
      this.settingsRepo.queueRow(instructorId),
    ]);
    const handle = state?.shopify_handle ?? null;
    const metaobjectId = state?.shopify_metaobject_id ?? null;
    return {
      handle,
      metaobjectId,
      status: toEntryStatus(state?.last_status),
      lastSyncedAt: state?.last_synced_at ?? null,
      lastError: queued?.last_error ?? null,
      queued: queued !== null,
      attempts: queued?.attempts ?? 0,
      previewUrl:
        handle && metaobjectId ? `${this.previewBaseUrl()}${handle}` : null,
    };
  }

  private async knownInstructorState(
    instructorId: string,
  ): Promise<InstructorShopifyState | null> {
    const [exists, state] = await Promise.all([
      this.settingsRepo.instructorExists(instructorId),
      this.syncRepo.getState(instructorId),
    ]);
    if (!exists && !state) {
      throw new NotFoundException(`Instructor ${instructorId} not found`);
    }
    return state;
  }

  private async isProcessing(): Promise<boolean> {
    if (!isMasterSwitchOn(this.config) || !isShopifyConfigured(this.config)) {
      return false;
    }
    const settings = await this.settingsRepo.getSettings();
    return settings?.enabled ?? false;
  }

  private previewBaseUrl(): string {
    const base =
      this.config.get<string>('SHOPIFY_STOREFRONT_PREVIEW_BASE_URL')?.trim() ||
      DEFAULT_STOREFRONT_PREVIEW_BASE_URL;
    return base.endsWith('/') ? base : `${base}/`;
  }
}

function toEntryStatus(
  value: string | null | undefined,
): InstructorShopifyEntryStatus | null {
  return value === 'active' || value === 'draft' ? value : null;
}
