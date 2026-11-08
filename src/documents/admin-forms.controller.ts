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
import { Throttle } from '@nestjs/throttler';
import { MINUTE_MS } from '../activation/activation-throttler.guard';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminFormsService } from './admin-forms.service';
import type { DocumentLanguage, UploadUrl } from './documents.types';
import {
  CreateFormDto,
  ExpectedRevisionDto,
  FormSourceUploadUrlDto,
  PutFormPlacementsDto,
  SaveFormDraftDto,
  SignatureCheckQueryDto,
  SignatureLookupQueryDto,
  UpdateFormDto,
} from './dto/form.dto';
import { parseDocumentLanguage } from './dto/template.dto';
import type {
  FormTemplate,
  FormTemplateSummary,
  SignatureCheck,
  Signer,
} from './form-templates.types';
import { SignFormsThrottlerGuard } from './sign-forms-throttler.guard';
import { SignatureLookupsService } from './signature-lookups.service';

export const SIGNATURE_CHECK_LIMIT = { limit: 60, ttl: MINUTE_MS };

/** `/admin/documents/forms`: customer waiver forms, one draft and published versions per language. */
@Controller('admin/documents/forms')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminFormsController {
  constructor(private readonly forms: AdminFormsService) {}

  @Get()
  list(): Promise<FormTemplateSummary[]> {
    return this.forms.list();
  }

  @Post()
  create(
    @Body() dto: CreateFormDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<FormTemplate> {
    return this.forms.create(dto, toActor(user, userAgent));
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<FormTemplate> {
    return this.forms.get(id);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateFormDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<FormTemplate> {
    return this.forms.update(id, dto, toActor(user, userAgent));
  }

  @Put(':id/versions/:lang')
  saveDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('lang', parseDocumentLanguage()) lang: DocumentLanguage,
    @Body() dto: SaveFormDraftDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<FormTemplate> {
    return this.forms.saveDraft(id, lang, dto, toActor(user, userAgent));
  }

  @Post(':id/versions/:lang/publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('lang', parseDocumentLanguage()) lang: DocumentLanguage,
    @Body() dto: ExpectedRevisionDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<FormTemplate> {
    return this.forms.publish(
      id,
      lang,
      toActor(user, userAgent),
      dto.expectedUpdatedAt,
    );
  }

  @Post(':id/versions/:lang/source/upload-url')
  @HttpCode(HttpStatus.OK)
  sourceUploadUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('lang', parseDocumentLanguage()) lang: DocumentLanguage,
    @Body() dto: FormSourceUploadUrlDto,
  ): Promise<UploadUrl> {
    return this.forms.sourceUploadUrl(id, lang, dto.contentLength);
  }

  @Post(':id/versions/:lang/source/confirm')
  @HttpCode(HttpStatus.OK)
  confirmSource(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('lang', parseDocumentLanguage()) lang: DocumentLanguage,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<FormTemplate & { placementsCleared: boolean }> {
    return this.forms.confirmSource(id, lang, toActor(user, userAgent));
  }

  @Delete(':id/versions/:lang/source')
  removeSource(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('lang', parseDocumentLanguage()) lang: DocumentLanguage,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<FormTemplate> {
    return this.forms.removeSource(id, lang, toActor(user, userAgent));
  }

  @Put(':id/versions/:lang/placements')
  putPlacements(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('lang', parseDocumentLanguage()) lang: DocumentLanguage,
    @Body() dto: PutFormPlacementsDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<FormTemplate> {
    return this.forms.putPlacements(
      id,
      lang,
      dto.placements,
      toActor(user, userAgent),
      dto.expectedUpdatedAt,
    );
  }
}

/** `GET /admin/signatures?q=` and `GET /admin/signatures/check?email=`: instructors and customers by name or email, with what they signed and when. */
@Controller('admin/signatures')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminSignaturesController {
  constructor(private readonly lookups: SignatureLookupsService) {}

  @Get()
  lookup(@Query() query: SignatureLookupQueryDto): Promise<Signer[]> {
    return this.lookups.lookup(query.q);
  }

  @Get('check')
  @UseGuards(SignFormsThrottlerGuard)
  @Throttle({ default: SIGNATURE_CHECK_LIMIT })
  check(@Query() query: SignatureCheckQueryDto): Promise<SignatureCheck> {
    return this.lookups.check(query.email);
  }
}
