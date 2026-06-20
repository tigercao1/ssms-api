import { IsIn } from 'class-validator';
import { ALLOWED_AVATAR_MIME } from './photo-upload-request.dto';
import type { AllowedAvatarMime } from './photo-upload-request.dto';

/**
 * Body for `POST /me/instructor/photo/confirm`. Only the content type is needed
 * — the public URL is recomputed server-side from the deterministic avatar path
 * so a client cannot persist an arbitrary URL on the profile.
 */
export class PhotoConfirmDto {
  @IsIn(ALLOWED_AVATAR_MIME, {
    message: `contentType must be one of: ${ALLOWED_AVATAR_MIME.join(', ')}`,
  })
  contentType!: AllowedAvatarMime;
}
