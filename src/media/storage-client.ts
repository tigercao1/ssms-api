import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

/** Result of requesting a signed upload URL from object storage. */
export interface SignedUpload {
  /** URL the client PUTs the file bytes to. */
  signedUrl: string;
  /** Upload token (Supabase Storage returns this alongside the URL). */
  token: string;
  /** Object path within the bucket. */
  path: string;
}

/**
 * Narrow storage abstraction so `MediaService` never touches the Supabase
 * Storage SDK directly. Tests bind a fake that records uploads and returns a
 * predictable URL (TESTING_STRATEGY.md § Storage / backend-architecture.md §2).
 */
export const STORAGE_CLIENT = Symbol('STORAGE_CLIENT');

export interface StorageClient {
  createSignedUploadUrl(bucket: string, path: string): Promise<SignedUpload>;
  getPublicUrl(bucket: string, path: string): string;
}

/** Supabase Storage (S3-backed) implementation. */
@Injectable()
export class SupabaseStorageClient implements StorageClient {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  async createSignedUploadUrl(
    bucket: string,
    path: string,
  ): Promise<SignedUpload> {
    // `upsert: true` lets an instructor replace their avatar at the stable path.
    const { data, error } = await this.supabase.storage
      .from(bucket)
      .createSignedUploadUrl(path, { upsert: true });
    if (error || !data) {
      throw new InternalServerErrorException(
        `Failed to create signed upload URL: ${error?.message ?? 'unknown error'}`,
      );
    }
    return { signedUrl: data.signedUrl, token: data.token, path: data.path };
  }

  getPublicUrl(bucket: string, path: string): string {
    const { data } = this.supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }
}
