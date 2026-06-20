import { IsIn, IsInt, IsPositive } from 'class-validator';

/** Allowed avatar mime types (INSTRUCTOR_PROFILE_FIELDS.md / backend-architecture.md §2). */
export const ALLOWED_AVATAR_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type AllowedAvatarMime = (typeof ALLOWED_AVATAR_MIME)[number];

/** 5 MB hard cap on avatar uploads. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * Body for `POST /me/instructor/photo/signed-upload-url`. The client declares
 * the file's content type and size up-front so we can reject oversized or
 * disallowed uploads BEFORE issuing a signed URL.
 */
export class PhotoUploadRequestDto {
  @IsIn(ALLOWED_AVATAR_MIME, {
    message: `contentType must be one of: ${ALLOWED_AVATAR_MIME.join(', ')}`,
  })
  contentType!: AllowedAvatarMime;

  @IsInt()
  @IsPositive()
  contentLength!: number;
}
