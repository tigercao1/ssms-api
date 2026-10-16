import { Injectable } from '@nestjs/common';
import { catalogs, en, type SupportedLanguage } from '../../i18n';
import { MailerConfig } from '../mailer.config';
import type {
  EmailLanguage,
  EmailTemplate,
  EmailTemplateVars,
  RenderedEmail,
} from '../mailer.types';
import {
  contentLanguage,
  renderEmailLayout,
  type EmailSection,
} from './email-layout';
import { EMAIL_TEMPLATES, type TemplateDefinition } from './email-templates';

const BILINGUAL_ORDER: SupportedLanguage[] = ['en', 'zh-CN'];

/**
 * Renders any {@link EmailTemplate} in `en`, `zh-CN` or `bilingual` through
 * the shared branded layout. Bilingual output is the en block, a divider,
 * then the zh-CN block, with a `"<en> / <zh>"` subject.
 */
@Injectable()
export class EmailRenderer {
  constructor(private readonly config: MailerConfig) {}

  render<T extends EmailTemplate>(
    template: T,
    language: EmailLanguage,
    vars: EmailTemplateVars[T],
  ): RenderedEmail {
    const definition = EMAIL_TEMPLATES[template] as TemplateDefinition<T>;
    const languages = language === 'bilingual' ? BILINGUAL_ORDER : [language];
    const sections: EmailSection[] = languages.map((lang) => ({
      language: lang,
      blocks: definition.build(catalogs[lang], vars, lang),
      layout: catalogs[lang].email.layout,
    }));
    const { html, text } = renderEmailLayout(sections, {
      logoUrl: this.config.logoUrl,
      replyTo: this.config.replyTo,
      brandName: en.email.layout.footerClub,
    });
    return {
      subject: sections.map((s) => s.blocks.subject).join(' / '),
      html,
      text,
      contentLanguage: contentLanguage(sections),
    };
  }

  /** Renders `template` with its realistic preview sample vars. */
  renderSample(
    template: EmailTemplate,
    language: EmailLanguage,
  ): RenderedEmail {
    return this.render(template, language, this.sampleVars(template));
  }

  sampleVars<T extends EmailTemplate>(template: T): EmailTemplateVars[T] {
    const definition = EMAIL_TEMPLATES[template] as TemplateDefinition<T>;
    return definition.sample({ portalUrl: this.config.portalUrl });
  }
}
