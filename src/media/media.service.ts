import {
  BadRequestException,
  Inject,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InstructorsService } from '../instructors/instructors.service';
import type { InstructorProfile } from '../instructors/instructors.types';
import {
  ALLOWED_AVATAR_MIME,
  AllowedAvatarMime,
  MAX_AVATAR_BYTES,
} from './dto/photo-upload-request.dto';
import { STORAGE_CLIENT } from './storage-client';
import type { StorageClient } from './storage-client';

const DEFAULT_BUCKET = 'instructor-public';

/** content-type → file extension (path convention `avatar.{ext}`). */
const MIME_EXT: Record<AllowedAvatarMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface AvatarUploadTicket {
  /** URL the client PUTs the file bytes to. */
  uploadUrl: string;
  /** Upload token returned by Supabase Storage. */
  token: string;
  /** Public URL to persist on the profile after a successful upload. */
  publicUrl: string;
  /** Object path within the bucket. */
  path: string;
  /** Echoed limits so the client can enforce them too. */
  maxBytes: number;
  allowedMimeTypes: readonly string[];
}

/**
 * T3.5 — Profile photo (avatar) uploads.
 *
 * Validates the declared mime type + size, issues a signed upload URL targeting
 * `instructor-public/{instructorId}/avatar.{ext}`, and (after the client
 * uploads) persists the resulting public URL on the instructor profile. v1 is
 * photos-only; private documents are deferred (DOCUMENT_STORAGE_PLAN.md).
 */
@Injectable()
export class MediaService {
  private readonly bucket: string;

  constructor(
    @Inject(STORAGE_CLIENT) private readonly storage: StorageClient,
    private readonly config: ConfigService,
    private readonly instructors: InstructorsService,
  ) {
    this.bucket =
      this.config.get<string>('SUPABASE_STORAGE_BUCKET') ?? DEFAULT_BUCKET;
  }

  /**
   * Validate the upload request and mint a signed upload URL for the avatar.
   * Rejects content types outside the allow-list (400) and files over the
   * 5 MB cap (413) before any storage call.
   */
  async createAvatarUploadUrl(
    instructorId: string,
    contentType: string,
    contentLength: number,
  ): Promise<AvatarUploadTicket> {
    if (!this.isAllowedMime(contentType)) {
      throw new BadRequestException(
        `Unsupported content type '${contentType}'. Allowed: ${ALLOWED_AVATAR_MIME.join(', ')}`,
      );
    }
    if (!Number.isInteger(contentLength) || contentLength <= 0) {
      throw new BadRequestException('contentLength must be a positive integer');
    }
    if (contentLength > MAX_AVATAR_BYTES) {
      throw new PayloadTooLargeException(
        `File exceeds the ${MAX_AVATAR_BYTES} byte (5 MB) limit`,
      );
    }

    const path = this.avatarPath(instructorId, contentType);
    const signed = await this.storage.createSignedUploadUrl(this.bucket, path);
    const publicUrl = this.storage.getPublicUrl(this.bucket, path);

    return {
      uploadUrl: signed.signedUrl,
      token: signed.token,
      publicUrl,
      path,
      maxBytes: MAX_AVATAR_BYTES,
      allowedMimeTypes: ALLOWED_AVATAR_MIME,
    };
  }

  /**
   * Persist an uploaded avatar on the instructor profile. Called after the
   * client confirms the PUT succeeded. The public URL is recomputed from the
   * (validated) content type rather than trusted from the client, so only URLs
   * produced by our own signed-upload flow can ever land on a profile
   * (INSTRUCTOR_PROFILE_FIELDS.md § Validation). Reuses the transactional
   * profile-update path. Returns the updated profile.
   */
  async confirmAvatarUpload(
    instructorId: string,
    contentType: string,
  ): Promise<InstructorProfile> {
    if (!this.isAllowedMime(contentType)) {
      throw new BadRequestException(
        `Unsupported content type '${contentType}'. Allowed: ${ALLOWED_AVATAR_MIME.join(', ')}`,
      );
    }
    const path = this.avatarPath(instructorId, contentType);
    const publicUrl = this.storage.getPublicUrl(this.bucket, path);
    return this.instructors.updateProfileById(instructorId, {
      profilePhotoUrl: publicUrl,
    });
  }

  private avatarPath(
    instructorId: string,
    contentType: AllowedAvatarMime,
  ): string {
    return `${instructorId}/avatar.${MIME_EXT[contentType]}`;
  }

  private isAllowedMime(value: string): value is AllowedAvatarMime {
    return (ALLOWED_AVATAR_MIME as readonly string[]).includes(value);
  }
}
