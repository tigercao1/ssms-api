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

export interface PhotoPlan {
  picture: string | null;
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
    const currentFileId = state?.shopify_photo_file_id ?? null;
    const version = instructor.profile_photo_version;
    if (!instructor.profile_photo_url) {
      return {
        picture: null,
        statePatch: currentFileId
          ? { shopify_photo_file_id: null, synced_photo_version: version }
          : {},
        replacedFileId: currentFileId,
      };
    }
    if (currentFileId && state?.synced_photo_version === version) {
      return { picture: currentFileId, statePatch: {}, replacedFileId: null };
    }
    const fileId = await this.upload(instructor);
    return {
      picture: fileId,
      statePatch: {
        shopify_photo_file_id: fileId,
        synced_photo_version: version,
      },
      replacedFileId: currentFileId !== fileId ? currentFileId : null,
    };
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

  private async upload(instructor: SyncInstructorRow): Promise<string> {
    const object = storageObject(instructor.profile_photo_url as string);
    const signedUrl = await this.repo.createSignedPhotoUrl(
      object.bucket,
      object.path,
      SIGNED_PHOTO_URL_TTL_SECONDS,
    );
    const versionEpoch = instructor.profile_photo_version
      ? Date.parse(instructor.profile_photo_version) || 0
      : 0;
    const file = await this.gateway.createImage(
      signedUrl,
      `instructor-${instructor.id}-${versionEpoch}.${object.extension}`,
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
