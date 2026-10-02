import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { InstructorProfile } from '../instructors/instructors.types';
import { PhotoConfirmDto } from '../media/dto/photo-confirm.dto';
import { PhotoUploadRequestDto } from '../media/dto/photo-upload-request.dto';
import { AvatarUploadTicket, MediaService } from '../media/media.service';
import { AdminService } from './admin.service';
import { Roles, RolesGuard } from './roles.guard';

@Controller('admin/instructors/:id/photo')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminMediaController {
  constructor(
    private readonly media: MediaService,
    private readonly admin: AdminService,
  ) {}

  @Post('signed-upload-url')
  async getSignedUploadUrl(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PhotoUploadRequestDto,
  ): Promise<AvatarUploadTicket> {
    await this.admin.getInstructor(id);
    return this.media.createAvatarUploadUrl(
      id,
      dto.contentType,
      dto.contentLength,
    );
  }

  @Post('confirm')
  async confirm(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PhotoConfirmDto,
  ): Promise<InstructorProfile> {
    await this.admin.getInstructor(id);
    return this.media.confirmAvatarUpload(id, dto.contentType);
  }
}
