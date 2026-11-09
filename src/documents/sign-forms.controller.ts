import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { clientIp } from '../activation/activation-throttler.guard';
import {
  CompleteFormDto,
  FormQueryDto,
  OriginalPdfQueryDto,
} from './dto/complete-form.dto';
import { FormSigningService } from './form-signing.service';
import type { CompletedForm, PublicForm } from './form-templates.types';
import type { PresignedUrl } from './private-storage.client';
import {
  SIGN_FORMS_COMPLETE_LIMIT,
  SignFormsThrottlerGuard,
} from './sign-forms-throttler.guard';

/** `/sign/forms/:slug`: public, no-login form signing (customer waivers), throttled per client IP. */
@Controller('sign/forms')
@UseGuards(SignFormsThrottlerGuard)
export class SignFormsController {
  constructor(private readonly forms: FormSigningService) {}

  @Get(':slug')
  get(
    @Param('slug') slug: string,
    @Query() query: FormQueryDto,
  ): Promise<PublicForm> {
    return this.forms.get(slug, query.lang ?? 'en');
  }

  @Get(':slug/original')
  @Header('Cache-Control', 'no-store')
  async original(
    @Param('slug') slug: string,
    @Query() query: OriginalPdfQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PresignedUrl | undefined> {
    const signed = await this.forms.originalUrl(slug, query.lang ?? 'en');
    if (query.format === 'json') {
      return signed;
    }
    res.status(HttpStatus.FOUND).location(signed.url);
    return undefined;
  }

  @Post(':slug/complete')
  @Throttle({ default: SIGN_FORMS_COMPLETE_LIMIT })
  complete(
    @Param('slug') slug: string,
    @Body() dto: CompleteFormDto,
    @Req() req: Request,
    @Headers('user-agent') userAgent?: string,
  ): Promise<CompletedForm> {
    return this.forms.complete(slug, dto, {
      ip: clientIp(req),
      userAgent: userAgent ?? null,
    });
  }
}
