import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { TOTAL_COUNT_HEADER } from '../config/cors';
import { DocumentExportsService } from './document-exports.service';
import type {
  DocumentExport,
  DocumentExportUrl,
  TemplateAssignmentRow,
} from './document-exports.types';
import {
  CreateDocumentExportDto,
  TemplateAssignmentsQueryDto,
} from './dto/export.dto';

/** Admin signed-copies index of a template and its bulk ZIP exports. */
@Controller('admin/documents')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminDocumentExportsController {
  constructor(private readonly exports: DocumentExportsService) {}

  @Get('templates/:id/assignments')
  async listAssignments(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: TemplateAssignmentsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TemplateAssignmentRow[]> {
    const { rows, total } = await this.exports.listAssignments(id, query);
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return rows;
  }

  @Post('templates/:id/exports')
  @HttpCode(HttpStatus.ACCEPTED)
  create(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateDocumentExportDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<DocumentExport> {
    return this.exports.create(id, dto, toActor(user, userAgent));
  }

  @Get('templates/:id/exports')
  listForTemplate(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DocumentExport[]> {
    return this.exports.listForTemplate(id);
  }

  @Get('exports/:exportId')
  get(
    @Param('exportId', new ParseUUIDPipe()) exportId: string,
  ): Promise<DocumentExport> {
    return this.exports.get(exportId);
  }

  @Get('exports/:exportId/url')
  downloadUrl(
    @Param('exportId', new ParseUUIDPipe()) exportId: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<DocumentExportUrl> {
    return this.exports.downloadUrl(exportId, toActor(user, userAgent));
  }
}
