import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { isEmailLanguage } from './email-language';
import {
  EMAIL_LANGUAGES,
  type EmailLanguage,
  type EmailTemplate,
} from './mailer.types';
import { escapeHtml } from './templates/email-layout';
import { EmailRenderer } from './templates/email-renderer';
import {
  EMAIL_TEMPLATE_NAMES,
  isEmailTemplate,
} from './templates/email-templates';

export interface EmailPreviewSummary {
  template: EmailTemplate;
  subjects: Record<EmailLanguage, string>;
  previewPaths: Record<EmailLanguage, string>;
}

/**
 * Admin-only previews of every email rendered with realistic sample vars, so
 * copy can be reviewed in a browser without sending anything.
 */
@Controller('admin/email-previews')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class EmailPreviewController {
  constructor(private readonly renderer: EmailRenderer) {}

  @Get()
  list(): EmailPreviewSummary[] {
    return EMAIL_TEMPLATE_NAMES.map((template) => ({
      template,
      subjects: this.byLanguage(
        (lang) => this.renderer.renderSample(template, lang).subject,
      ),
      previewPaths: this.byLanguage(
        (lang) =>
          `/admin/email-previews/${template}?lang=${encodeURIComponent(lang)}`,
      ),
    }));
  }

  /** `?lang=en|zh-CN|bilingual` (default bilingual); `?format=text` for the plain-text part. */
  @Get(':template')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Type', 'text/html; charset=utf-8')
  preview(
    @Param('template') template: string,
    @Query('lang') lang?: string,
    @Query('format') format?: string,
  ): string {
    if (!isEmailTemplate(template)) {
      throw new NotFoundException(`Unknown email template '${template}'`);
    }
    const language = lang ?? 'bilingual';
    if (!isEmailLanguage(language)) {
      throw new BadRequestException(
        `lang must be one of: ${EMAIL_LANGUAGES.join(', ')}`,
      );
    }
    const rendered = this.renderer.renderSample(template, language);
    if (format === 'text') {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><pre style="white-space:pre-wrap;font-family:monospace;">${escapeHtml(rendered.text)}</pre></body></html>`;
    }
    return rendered.html;
  }

  private byLanguage(
    fn: (lang: EmailLanguage) => string,
  ): Record<EmailLanguage, string> {
    return Object.fromEntries(
      EMAIL_LANGUAGES.map((lang) => [lang, fn(lang)]),
    ) as Record<EmailLanguage, string>;
  }
}
