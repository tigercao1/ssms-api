import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  defaultShopifyRuntime,
  SHOPIFY_RUNTIME,
  type ShopifyRuntime,
} from '../shopify/shopify-runtime';
import { InstructorSyncRepository } from './instructor-sync.repository';
import type {
  InstructorShopifyState,
  InstructorShopifyStatePatch,
  SyncInstructorRow,
} from './instructor-sync.types';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';

export const PHOTO_POLL_ATTEMPTS = 10;
export const PHOTO_POLL_INTERVAL_MS = 2_000;
export const SIGNED_PHOTO_URL_TTL_SECONDS = 600;

export type PhotoField = 'picture' | 'image_1' | 'image_2';

export interface PhotoPlan {
  fields: Partial<Record<PhotoField, string | null>>;
  statePatch: InstructorShopifyStatePatch;
  replacedFileIds: string[];
}

interface PhotoSlot {
  field: PhotoField;
  filenameTag: string;
  url: 'profile_photo_url' | 'photo_2_url' | 'photo_3_url';
  version: 'profile_photo_version' | 'photo_2_version' | 'photo_3_version';
  fileId:
    | 'shopify_photo_file_id'
    | 'shopify_photo_2_file_id'
    | 'shopify_photo_3_file_id';
  syncedVersion:
    | 'synced_photo_version'
    | 'synced_photo_2_version'
    | 'synced_photo_3_version';
  alwaysWrite: boolean;
}

export const PHOTO_SLOTS: readonly PhotoSlot[] = [
  {
    field: 'picture',
    filenameTag: '',
    url: 'profile_photo_url',
    version: 'profile_photo_version',
    fileId: 'shopify_photo_file_id',
    syncedVersion: 'synced_photo_version',
    alwaysWrite: true,
  },
  {
    field: 'image_1',
    filenameTag: '2-',
    url: 'photo_2_url',
    version: 'photo_2_version',
    fileId: 'shopify_photo_2_file_id',
    syncedVersion: 'synced_photo_2_version',
    alwaysWrite: false,
  },
  {
    field: 'image_2',
    filenameTag: '3-',
    url: 'photo_3_url',
    version: 'photo_3_version',
    fileId: 'shopify_photo_3_file_id',
    syncedVersion: 'synced_photo_3_version',
    alwaysWrite: false,
  },
];

interface SlotPlan {
  value: string | null | undefined;
  statePatch: InstructorShopifyStatePatch;
  replacedFileId: string | null;
}

interface StorageObject {
  bucket: string;
  path: string;
  extension: string;
}

const STORAGE_OBJECT_PATH =
  /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/;

@Injectable()
export class InstructorPhotoSync {
  private readonly logger = new Logger(InstructorPhotoSync.name);
  private readonly sleep: ShopifyRuntime['sleep'];

  constructor(
    private readonly repo: InstructorSyncRepository,
    private readonly gateway: ShopifyInstructorGateway,
    @Optional()
    @Inject(SHOPIFY_RUNTIME)
    runtime?: Partial<ShopifyRuntime>,
  ) {
    this.sleep = runtime?.sleep ?? defaultShopifyRuntime.sleep;
  }

  async prepare(
    instructor: SyncInstructorRow,
    state: InstructorShopifyState | null,
  ): Promise<PhotoPlan> {
    const plan: PhotoPlan = { fields: {}, statePatch: {}, replacedFileIds: [] };
    for (const slot of PHOTO_SLOTS) {
      const slotPlan = await this.prepareSlot(slot, instructor, state);
      if (slotPlan.value !== undefined) {
        plan.fields[slot.field] = slotPlan.value;
      }
      Object.assign(plan.statePatch, slotPlan.statePatch);
      if (slotPlan.replacedFileId) {
        plan.replacedFileIds.push(slotPlan.replacedFileId);
      }
    }
    return plan;
  }

  async discard(fileId: string | null): Promise<void> {
    if (!fileId) {
      return;
    }
    try {
      await this.gateway.deleteFiles([fileId]);
    } catch (err) {
      this.logger.warn(
        `Could not delete replaced Shopify file ${fileId}: ${(err as Error).message}`,
      );
    }
  }

  private async prepareSlot(
    slot: PhotoSlot,
    instructor: SyncInstructorRow,
    state: InstructorShopifyState | null,
  ): Promise<SlotPlan> {
    const currentFileId = state?.[slot.fileId] ?? null;
    const version = instructor[slot.version];
    const url = instructor[slot.url];
    if (!url) {
      if (!currentFileId) {
        return {
          value: slot.alwaysWrite ? null : undefined,
          statePatch: {},
          replacedFileId: null,
        };
      }
      return {
        value: null,
        statePatch: { [slot.fileId]: null, [slot.syncedVersion]: version },
        replacedFileId: currentFileId,
      };
    }
    if (currentFileId && state?.[slot.syncedVersion] === version) {
      return { value: currentFileId, statePatch: {}, replacedFileId: null };
    }
    const fileId = await this.upload(instructor, slot, url, version);
    return {
      value: fileId,
      statePatch: { [slot.fileId]: fileId, [slot.syncedVersion]: version },
      replacedFileId: currentFileId !== fileId ? currentFileId : null,
    };
  }

  private async upload(
    instructor: SyncInstructorRow,
    slot: PhotoSlot,
    url: string,
    version: string | null,
  ): Promise<string> {
    const object = storageObject(url);
    const signedUrl = await this.repo.createSignedPhotoUrl(
      object.bucket,
      object.path,
      SIGNED_PHOTO_URL_TTL_SECONDS,
    );
    const versionEpoch = version ? Date.parse(version) || 0 : 0;
    const file = await this.gateway.createImage(
      signedUrl,
      `instructor-${instructor.id}-${slot.filenameTag}${versionEpoch}.${object.extension}`,
    );
    await this.waitUntilReady(file.id, file.fileStatus);
    return file.id;
  }

  private async waitUntilReady(
    fileId: string,
    initialStatus: string,
  ): Promise<void> {
    let status = initialStatus;
    let errors: string[] = [];
    for (let attempt = 1; ; attempt++) {
      if (status === 'READY') {
        return;
      }
      if (status === 'FAILED') {
        await this.discard(fileId);
        throw new Error(
          `Shopify could not process photo ${fileId}: ${errors.join('; ') || 'no detail'}`,
        );
      }
      if (attempt > PHOTO_POLL_ATTEMPTS) {
        throw new Error(
          `Shopify photo ${fileId} not ready after ${PHOTO_POLL_ATTEMPTS} checks (last status ${status})`,
        );
      }
      await this.sleep(PHOTO_POLL_INTERVAL_MS);
      const state = await this.gateway.fileState(fileId);
      if (!state) {
        throw new Error(`Shopify photo ${fileId} disappeared while processing`);
      }
      status = state.fileStatus;
      errors = state.errors;
    }
  }
}

export function storageObject(url: string): StorageObject {
  const match = STORAGE_OBJECT_PATH.exec(new URL(url).pathname);
  const path = match ? decodeURIComponent(match[2]) : '';
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (!match || !extension) {
    throw new Error(`Unrecognised profile photo URL: ${url}`);
  }
  return { bucket: decodeURIComponent(match[1]), path, extension };
}
