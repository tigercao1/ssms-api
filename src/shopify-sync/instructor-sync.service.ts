import { Injectable } from '@nestjs/common';
import { GoLiveService } from './go-live.service';
import {
  buildInstructorFields,
  englishTranslations,
} from './instructor-fields.builder';
import {
  baseHandle,
  handleCandidates,
  type HandleSource,
  isFallbackHandle,
} from './instructor-handle';
import { InstructorPhotoSync } from './instructor-photo.sync';
import { InstructorSyncRepository } from './instructor-sync.repository';
import { InstructorTranslationsSync } from './instructor-translations.sync';
import { LegacyRoster } from './legacy-roster';
import type {
  InstructorShopifyState,
  InstructorSnapshot,
} from './instructor-sync.types';
import {
  type ShopifyEntryRef,
  ShopifyInstructorGateway,
} from './shopify-instructor.gateway';

export type SyncOutcome = 'active' | 'draft' | 'held' | 'skipped';

export interface ReconcileResult {
  enqueued: number;
  instructors: number;
  orphaned: number;
}

@Injectable()
export class InstructorSyncService {
  constructor(
    private readonly repo: InstructorSyncRepository,
    private readonly gateway: ShopifyInstructorGateway,
    private readonly photos: InstructorPhotoSync,
    private readonly translations: InstructorTranslationsSync,
    private readonly goLive: GoLiveService,
    private readonly legacy: LegacyRoster,
  ) {}

  async sync(instructorId: string): Promise<SyncOutcome> {
    const [assessment, state] = await Promise.all([
      this.goLive.assess(instructorId),
      this.repo.getState(instructorId),
    ]);
    if (!assessment?.readiness.ready) {
      return this.hide(instructorId, state);
    }
    if (await this.legacy.holdFor(assessment.publishable.instructor, state)) {
      await this.hide(instructorId, state);
      return 'held';
    }
    return this.publish(assessment.publishable, state);
  }

  async reconcile(): Promise<ReconcileResult> {
    const counts = await this.repo.enqueueAll();
    return { enqueued: counts.instructors + counts.orphaned, ...counts };
  }

  private async hide(
    instructorId: string,
    state: InstructorShopifyState | null,
  ): Promise<SyncOutcome> {
    if (!state?.shopify_metaobject_id || !state.shopify_handle) {
      return 'skipped';
    }
    const stored = await this.gateway.findEntryById(
      state.shopify_metaobject_id,
    );
    const entry = stored
      ? await this.gateway.updateEntry(stored.id, { status: 'DRAFT' })
      : await this.gateway.setEntryStatus(state.shopify_handle, 'DRAFT');
    await this.repo.saveState(instructorId, {
      shopify_metaobject_id: entry.id,
      shopify_handle: entry.handle,
      last_synced_at: new Date().toISOString(),
      last_status: 'draft',
    });
    return 'draft';
  }

  private async publish(
    snapshot: InstructorSnapshot,
    state: InstructorShopifyState | null,
  ): Promise<SyncOutcome> {
    const { instructor } = snapshot;
    const found = await this.ownEntry(instructor.id, state);
    const target = found ? await this.healedTarget(instructor, found) : null;
    const newHandle = target
      ? null
      : await this.newEntryHandle(instructor, state);
    const photo = await this.photos.prepare(instructor, state);
    const fields = buildInstructorFields(snapshot, {
      existingEntry: target !== null,
      ...photo.fields,
    });
    const entry = target
      ? await this.gateway.updateEntry(target.entry.id, {
          handle: target.rename,
          fields,
          status: 'ACTIVE',
        })
      : await this.gateway.upsertEntry(newHandle as string, fields, 'ACTIVE');
    if (found && target && target.entry.id !== found.id) {
      await this.gateway.updateEntry(found.id, { status: 'DRAFT' });
    }
    await this.repo.saveState(instructor.id, {
      ...photo.statePatch,
      shopify_metaobject_id: entry.id,
      shopify_handle: entry.handle,
      last_synced_at: new Date().toISOString(),
      last_status: 'active',
    });
    for (const fileId of photo.replacedFileIds) {
      await this.photos.discard(fileId);
    }
    await this.translations.apply(entry.id, englishTranslations(snapshot));
    return 'active';
  }

  private async ownEntry(
    instructorId: string,
    state: InstructorShopifyState | null,
  ): Promise<ShopifyEntryRef | null> {
    const stored = state?.shopify_metaobject_id
      ? await this.gateway.findEntryById(state.shopify_metaobject_id)
      : null;
    if (stored?.ssmsId && stored.ssmsId !== instructorId) {
      throw new Error(
        `Stored entry ${stored.id} belongs to another instructor (${stored.ssmsId})`,
      );
    }
    return stored ?? this.gateway.findEntryBySsmsId(instructorId);
  }

  private async healedTarget(
    instructor: HandleSource,
    entry: ShopifyEntryRef,
  ): Promise<{ entry: ShopifyEntryRef; rename?: string }> {
    if (!isFallbackHandle(entry.handle, instructor.id)) {
      return { entry };
    }
    const base = baseHandle(instructor);
    if (isFallbackHandle(base, instructor.id)) {
      return { entry };
    }
    const legacyHandles = await this.legacy.handles();
    for (const candidate of handleCandidates(base, instructor.id)) {
      if (
        legacyHandles.has(candidate) ||
        (await this.repo.isHandleStoredByOther(candidate, instructor.id))
      ) {
        continue;
      }
      const holder = await this.gateway.findEntryByHandle(candidate);
      if (!holder) {
        return { entry, rename: candidate };
      }
      if (holder.ssmsId === instructor.id) {
        return { entry: holder };
      }
    }
    return { entry };
  }

  private async newEntryHandle(
    instructor: HandleSource,
    state: InstructorShopifyState | null,
  ): Promise<string> {
    return state?.shopify_handle
      ? this.verifiedStoredHandle(instructor.id, state.shopify_handle)
      : this.claimHandle(instructor);
  }

  private async verifiedStoredHandle(
    instructorId: string,
    handle: string,
  ): Promise<string> {
    const entry = await this.gateway.findEntryByHandle(handle);
    if (entry && entry.ssmsId !== instructorId) {
      throw new Error(
        `Stored handle "${handle}" belongs to another ${entry.ssmsId ? `instructor (${entry.ssmsId})` : 'entry'}`,
      );
    }
    return handle;
  }

  private async claimHandle(instructor: HandleSource): Promise<string> {
    const base = baseHandle(instructor);
    const legacyHandles = await this.legacy.handles();
    for (const candidate of handleCandidates(base, instructor.id)) {
      if (legacyHandles.has(candidate)) {
        continue;
      }
      if (await this.repo.isHandleStoredByOther(candidate, instructor.id)) {
        continue;
      }
      const entry = await this.gateway.findEntryByHandle(candidate);
      if (entry && entry.ssmsId !== instructor.id) {
        continue;
      }
      await this.repo.saveState(instructor.id, { shopify_handle: candidate });
      return candidate;
    }
    throw new Error(`No free handle for "${base}"`);
  }
}
