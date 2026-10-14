import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminCertificationUploadsService } from './admin-certification-uploads.service';
import type { CertUpload, CertificationFileUrl } from './documents.types';
import { ReviewCertificationUploadDto } from './dto/certification-upload.dto';

/** Admin review of instructors' certification uploads. */
@Controller('admin/certification-uploads')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminCertificationUploadsController {
  constructor(private readonly uploads: AdminCertificationUploadsService) {}

  @Get(':id/url')
  fileUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<CertificationFileUrl> {
    return this.uploads.fileUrl(id, toActor(user, userAgent));
  }

  @Patch(':id')
  review(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReviewCertificationUploadDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<CertUpload> {
    return this.uploads.review(id, dto, toActor(user, userAgent));
  }
}
