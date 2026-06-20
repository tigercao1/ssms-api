import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { InstructorsService } from '../instructors/instructors.service';
import type { InstructorProfile } from '../instructors/instructors.types';
import { PhotoUploadRequestDto } from './dto/photo-upload-request.dto';
import { PhotoConfirmDto } from './dto/photo-confirm.dto';
import { AvatarUploadTicket, MediaService } from './media.service';

/**
 * Profile-photo endpoints (T3.5). Same guard stack as `/me/instructor`:
 * valid JWT + verified email, scoped to the caller's own profile.
 *
 * Flow (CREATE_INSTRUCTOR_EXAMPLE.md § Step 5):
 *   1. POST .../signed-upload-url  → validate mime+size, get { uploadUrl, publicUrl }
 *   2. client PUTs the file to uploadUrl
 *   3. POST .../confirm            → persist publicUrl on the profile
 */
@Controller('me/instructor/photo')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly instructors: InstructorsService,
  ) {}

  @Post('signed-upload-url')
  async getSignedUploadUrl(
    @CurrentUser() user: SupabaseJwtPayload,
    @Body() dto: PhotoUploadRequestDto,
  ): Promise<AvatarUploadTicket> {
    const instructorId = await this.resolveInstructorId(user);
    return this.media.createAvatarUploadUrl(
      instructorId,
      dto.contentType,
      dto.contentLength,
    );
  }

  @Post('confirm')
  async confirm(
    @CurrentUser() user: SupabaseJwtPayload,
    @Body() dto: PhotoConfirmDto,
  ): Promise<InstructorProfile> {
    const instructorId = await this.resolveInstructorId(user);
    return this.media.confirmAvatarUpload(instructorId, dto.contentType);
  }

  /** Resolve (or lazily create) the caller's instructor row id from the JWT. */
  private async resolveInstructorId(user: SupabaseJwtPayload): Promise<string> {
    const profile = await this.instructors.getOrCreateForUser(
      user.sub,
      user.email ?? '',
    );
    return profile.id;
  }
}
