import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { MAX_FORM_PDF_BYTES } from './dto/form.dto';
import { ImportJotformSignatureDto } from './dto/jotform-import.dto';
import {
  JotformImportsService,
  type UploadedPdf,
} from './jotform-imports.service';
import type { JotformImportResult } from './jotform-imports.types';

/** `POST /admin/signatures/jotform`: files one signed Jotform waiver (multipart, PDF in `pdf`) as a completed waiver signature; re-sending a submission returns the existing one. */
@Controller('admin/signatures/jotform')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminJotformImportsController {
  constructor(private readonly imports: JotformImportsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('pdf', {
      limits: { fileSize: MAX_FORM_PDF_BYTES, files: 1 },
    }),
  )
  import(
    @UploadedFile() pdf: UploadedPdf | undefined,
    @Body() dto: ImportJotformSignatureDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<JotformImportResult> {
    return this.imports.import(dto, pdf, toActor(user, userAgent));
  }
}
