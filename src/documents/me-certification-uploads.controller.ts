import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { CertUpload, CertificationUploadUrl } from './documents.types';
import { CertificationUploadUrlDto } from './dto/certification-upload.dto';
import { MeCertificationUploadsService } from './me-certification-uploads.service';

/** `/me/certification-uploads`: the calling instructor uploads certification proof. */
@Controller('me/certification-uploads')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class MeCertificationUploadsController {
  constructor(private readonly uploads: MeCertificationUploadsService) {}

  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  uploadUrl(
    @Body() dto: CertificationUploadUrlDto,
    @CurrentUser() user: SupabaseJwtPayload,
  ): Promise<CertificationUploadUrl> {
    return this.uploads.uploadUrl(user.sub, dto);
  }

  @Post(':uploadId/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    @CurrentUser() user: SupabaseJwtPayload,
  ): Promise<CertUpload> {
    return this.uploads.confirm(user.sub, uploadId);
  }
}
