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
import { AdminFormsService } from './admin-forms.service';
import type { DocumentLanguage } from './documents.types';
import {
  CreateFormDto,
  SaveFormDraftDto,
  SignatureLookupQueryDto,
  UpdateFormDto,
} from './dto/form.dto';
import { parseDocumentLanguage } from './dto/template.dto';
import type {
  FormTemplate,
  FormTemplateSummary,
  Signer,
} from './form-templates.types';
import { SignatureLookupsService } from './signature-lookups.service';

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
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<FormTemplate> {
    return this.forms.publish(id, lang, toActor(user, userAgent));
  }
}

/** `GET /admin/signatures?q=`: instructors and customers by name or email, with what they signed and when. */
@Controller('admin/signatures')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminSignaturesController {
  constructor(private readonly lookups: SignatureLookupsService) {}

  @Get()
  lookup(@Query() query: SignatureLookupQueryDto): Promise<Signer[]> {
    return this.lookups.lookup(query.q);
  }
}
