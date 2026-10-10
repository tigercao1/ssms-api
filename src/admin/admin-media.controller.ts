import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { InstructorProfile } from '../instructors/instructors.types';
import { PhotoConfirmDto } from '../media/dto/photo-confirm.dto';
import {
  PhotoUploadRequestDto,
  type PhotoSlot,
} from '../media/dto/photo-upload-request.dto';
import { AvatarUploadTicket, MediaService } from '../media/media.service';
import { ParsePhotoSlotPipe } from '../media/photo-slot.pipe';
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
      dto.slot,
    );
  }

  @Post('confirm')
  async confirm(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PhotoConfirmDto,
  ): Promise<InstructorProfile> {
    await this.admin.getInstructor(id);
    return this.media.confirmAvatarUpload(id, dto.contentType, dto.slot);
  }

  @Delete(':slot')
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('slot', ParsePhotoSlotPipe) slot: PhotoSlot,
  ): Promise<InstructorProfile> {
    await this.admin.getInstructor(id);
    return this.media.removePhoto(id, slot);
  }
}
