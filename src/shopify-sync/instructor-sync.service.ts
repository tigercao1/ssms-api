import { Injectable } from '@nestjs/common';
import {
  buildInstructorFields,
  englishTranslations,
} from './instructor-fields.builder';
import { baseHandle, handleCandidate } from './instructor-handle';
import { InstructorPhotoSync } from './instructor-photo.sync';
import { InstructorSyncRepository } from './instructor-sync.repository';
import { InstructorTranslationsSync } from './instructor-translations.sync';
import {
  type InstructorShopifyState,
  type InstructorSnapshot,
  isVisible,
} from './instructor-sync.types';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';

export type SyncOutcome = 'active' | 'draft' | 'skipped';

export interface ReconcileResult {
  enqueued: number;
  instructors: number;
  orphaned: number;
}

export const MAX_HANDLE_ATTEMPTS = 50;

@Injectable()
export class InstructorSyncService {
  constructor(
    private readonly repo: InstructorSyncRepository,
    private readonly gateway: ShopifyInstructorGateway,
    private readonly photos: InstructorPhotoSync,
    private readonly translations: InstructorTranslationsSync,
  ) {}

  async sync(instructorId: string): Promise<SyncOutcome> {
    const [snapshot, state] = await Promise.all([
      this.repo.loadSnapshot(instructorId),
      this.repo.getState(instructorId),
    ]);
    if (!snapshot || !isVisible(snapshot.instructor)) {
      return this.hide(instructorId, state);
    }
    return this.publish(snapshot, state);
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
    await this.gateway.setEntryStatus(state.shopify_handle, 'DRAFT');
    await this.repo.saveState(instructorId, {
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
    const existingEntry = Boolean(state?.shopify_metaobject_id);
    const handle = state?.shopify_handle
      ? await this.verifiedStoredHandle(
          instructor.id,
          state.shopify_handle,
          existingEntry,
        )
      : await this.claimHandle(instructor.id, instructor.display_name_en);
    const photo = await this.photos.prepare(instructor, state);
    const fields = buildInstructorFields(snapshot, {
      existingEntry,
      picture: photo.picture,
    });
    const entry = await this.gateway.upsertEntry(handle, fields, 'ACTIVE');
    await this.repo.saveState(instructor.id, {
      ...photo.statePatch,
      shopify_metaobject_id: entry.id,
      last_synced_at: new Date().toISOString(),
      last_status: 'active',
    });
    await this.photos.discard(photo.replacedFileId);
    await this.translations.apply(entry.id, englishTranslations(snapshot));
    return 'active';
  }

  private async verifiedStoredHandle(
    instructorId: string,
    handle: string,
    existingEntry: boolean,
  ): Promise<string> {
    if (existingEntry) {
      return handle;
    }
    const entry = await this.gateway.findEntryByHandle(handle);
    if (entry && entry.ssmsId !== instructorId) {
      throw new Error(
        `Stored handle "${handle}" belongs to another ${entry.ssmsId ? `instructor (${entry.ssmsId})` : 'entry'}`,
      );
    }
    return handle;
  }

  private async claimHandle(
    instructorId: string,
    displayNameEn: string,
  ): Promise<string> {
    const base = baseHandle(instructorId, displayNameEn);
    for (let attempt = 1; attempt <= MAX_HANDLE_ATTEMPTS; attempt++) {
      const candidate = handleCandidate(base, attempt);
      if (await this.repo.isHandleStoredByOther(candidate, instructorId)) {
        continue;
      }
      const entry = await this.gateway.findEntryByHandle(candidate);
      if (entry && entry.ssmsId !== instructorId) {
        continue;
      }
      await this.repo.saveState(instructorId, { shopify_handle: candidate });
      return candidate;
    }
    throw new Error(`No free handle for "${base}"`);
  }
}
