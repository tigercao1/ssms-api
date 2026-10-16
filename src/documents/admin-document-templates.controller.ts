import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { DocumentPublishingService } from './document-publishing.service';
import { DocumentTemplatesService } from './document-templates.service';
import type {
  ConfirmedTemplate,
  PublishPreview,
  PublishResult,
  Template,
  TemplateSummary,
  UploadUrl,
} from './documents.types';
import {
  ChangeAudienceDto,
  CreateTemplateDto,
  PublishPreviewQueryDto,
  PublishTemplateDto,
  PutTemplateFieldsDto,
  SourceUploadUrlDto,
  UpdateTemplateDto,
} from './dto/template.dto';

/** `/admin/documents/templates`: template metadata, source PDF, placed fields and publishing. */
@Controller('admin/documents/templates')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminDocumentTemplatesController {
  constructor(
    private readonly templates: DocumentTemplatesService,
    private readonly publishing: DocumentPublishingService,
  ) {}

  @Get()
  list(): Promise<TemplateSummary[]> {
    return this.templates.list();
  }

  @Post()
  create(
    @Body() dto: CreateTemplateDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<Template> {
    return this.templates.create(dto, toActor(user, userAgent));
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<Template> {
    return this.templates.get(id);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<Template> {
    return this.templates.update(id, dto, toActor(user, userAgent));
  }

  @Post(':id/source/upload-url')
  @HttpCode(HttpStatus.OK)
  sourceUploadUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SourceUploadUrlDto,
  ): Promise<UploadUrl> {
    return this.templates.sourceUploadUrl(id, dto.contentLength);
  }

  @Post(':id/source/confirm')
  @HttpCode(HttpStatus.OK)
  confirmSource(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<ConfirmedTemplate> {
    return this.templates.confirmSource(id, toActor(user, userAgent));
  }

  @Put(':id/fields')
  putFields(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PutTemplateFieldsDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<Template> {
    return this.templates.putFields(
      id,
      dto.fields.map((f) => ({
        ...f,
        labelZh: f.labelZh ?? null,
        prefill: f.prefill ?? null,
      })),
      toActor(user, userAgent),
    );
  }

  @Get(':id/publish-preview')
  publishPreview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: PublishPreviewQueryDto,
  ): Promise<PublishPreview> {
    return this.publishing.preview(id, query.season);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PublishTemplateDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PublishResult> {
    return this.publishing.publish(id, dto, toActor(user, userAgent));
  }

  @Post(':id/audience')
  @HttpCode(HttpStatus.OK)
  changeAudience(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ChangeAudienceDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PublishResult> {
    return this.publishing.changeAudience(id, dto, toActor(user, userAgent));
  }

  @Post(':id/retire')
  @HttpCode(HttpStatus.OK)
  retire(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<Template> {
    return this.publishing.retire(id, toActor(user, userAgent));
  }
}
