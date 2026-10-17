import {
  Body,
  Controller,
  Delete,
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
  DocumentLanguage,
  PublishPreview,
  PublishResult,
  Template,
  TemplateField,
  TemplateSummary,
  UploadUrl,
} from './documents.types';
import {
  ChangeAudienceDto,
  CreateTemplateDto,
  parseDocumentLanguage,
  PublishPreviewQueryDto,
  PublishTemplateDto,
  PutTemplateFieldsDto,
  SourceUploadUrlDto,
  UpdateTemplateDto,
} from './dto/template.dto';

function toTemplateFields(dto: PutTemplateFieldsDto): TemplateField[] {
  return dto.fields.map((f) => ({
    ...f,
    labelZh: f.labelZh ?? null,
    prefill: f.prefill ?? null,
  }));
}

/** `/admin/documents/templates`: template metadata, source PDF, placed fields, language versions and publishing. */
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
      toTemplateFields(dto),
      toActor(user, userAgent),
    );
  }

  @Post(':id/translations/:language/source/upload-url')
  @HttpCode(HttpStatus.OK)
  translationUploadUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('language', parseDocumentLanguage()) language: DocumentLanguage,
    @Body() dto: SourceUploadUrlDto,
  ): Promise<UploadUrl> {
    return this.templates.translationUploadUrl(
      id,
      language,
      dto.contentLength,
    );
  }

  @Post(':id/translations/:language/source/confirm')
  @HttpCode(HttpStatus.OK)
  confirmTranslationSource(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('language', parseDocumentLanguage()) language: DocumentLanguage,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<ConfirmedTemplate> {
    return this.templates.confirmTranslationSource(
      id,
      language,
      toActor(user, userAgent),
    );
  }

  @Put(':id/translations/:language/fields')
  putTranslationFields(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('language', parseDocumentLanguage()) language: DocumentLanguage,
    @Body() dto: PutTemplateFieldsDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<Template> {
    return this.templates.putTranslationFields(
      id,
      language,
      toTemplateFields(dto),
      toActor(user, userAgent),
    );
  }

  @Delete(':id/translations/:language')
  removeTranslation(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('language', parseDocumentLanguage()) language: DocumentLanguage,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<Template> {
    return this.templates.removeTranslation(
      id,
      language,
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
