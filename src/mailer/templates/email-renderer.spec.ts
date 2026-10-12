import { ConfigService } from '@nestjs/config';
import { en, zhCN } from '../../i18n';
import { MailerConfig } from '../mailer.config';
import { EMAIL_LANGUAGES, type EmailTemplate } from '../mailer.types';
import { EmailRenderer } from './email-renderer';
import { BRAND_RED } from './email-layout';
import { EMAIL_TEMPLATE_NAMES, isEmailTemplate } from './email-templates';

const LOGO = 'https://cdn.example.com/email-logo.png';
const renderer = new EmailRenderer(
  new MailerConfig({
    get: (key: string) =>
      ({ PORTAL_URL: 'https://portal.example.com', EMAIL_LOGO_URL: LOGO })[key],
  } as unknown as ConfigService),
);

const ALL_TEMPLATES: EmailTemplate[] = [
  'approved',
  'rejected',
  'deactivated',
  'reactivated',
  'auth.confirm_signup',
  'auth.recovery',
  'auth.magic_link',
  'auth.invite',
  'auth.email_change',
  'auth.reauthentication',
  'auth.password_changed',
  'invite.season',
  'invite.reminder',
  'admin.instructor_pending',
];

describe('EmailRenderer', () => {
  it('registers exactly the full template set', () => {
    expect([...EMAIL_TEMPLATE_NAMES].sort()).toEqual([...ALL_TEMPLATES].sort());
    expect(isEmailTemplate('approved')).toBe(true);
    expect(isEmailTemplate('toString')).toBe(false);
  });

  describe.each(ALL_TEMPLATES)('%s', (template) => {
    it.each(EMAIL_LANGUAGES)(
      'renders an email-client-safe %s email',
      (language) => {
        const { subject, html, text } = renderer.renderSample(
          template,
          language,
        );
        expect(subject.length).toBeGreaterThan(0);
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('role="presentation"');
        expect(html).toContain('max-width:560px');
        expect(html).toContain(`src="${LOGO}"`);
        expect(html).not.toMatch(/<svg|<style|<link|<script|\.svg/i);
        expect(html).toContain('Serendipity Snow Club');
        expect(html).toContain('href="mailto:info@ssnow.club"');
        expect(`${subject}${html}${text}`).not.toMatch(/\{[a-zA-Z]+\}/);
        expect(text).toContain('Serendipity Snow Club');
        expect(text).not.toContain('<');

        const direct = renderer.render(
          template,
          language,
          renderer.sampleVars(template),
        );
        expect(direct).toEqual({ subject, html, text });
      },
    );

    it('renders a bilingual email as zh-CN, divider, then en', () => {
      const zh = renderer.renderSample(template, 'zh-CN');
      const english = renderer.renderSample(template, 'en');
      const both = renderer.renderSample(template, 'bilingual');

      expect(both.subject).toBe(`${zh.subject} / ${english.subject}`);
      const zhAt = both.html.indexOf(zhCN.email.layout.signoffTeam);
      const enAt = both.html.indexOf(en.email.layout.signoffTeam);
      expect(zhAt).toBeGreaterThan(-1);
      expect(enAt).toBeGreaterThan(zhAt);
      expect(both.html).toContain('lang="zh-CN"');
      expect(both.html).toContain('lang="en"');
      expect(both.text.indexOf(zhCN.email.layout.footerQuestions)).toBeLessThan(
        both.text.indexOf(en.email.layout.footerQuestions),
      );
      expect(both.text).toContain('------------------------------');
    });
  });

  it('approved: greets by name and links a red Sign in button to the login page', () => {
    const { subject, html, text } = renderer.render('approved', 'en', {
      displayName: 'Jane',
      loginUrl: 'https://portal.example.com/login',
    });
    expect(subject).toBe(en.email.approved.subject);
    expect(html).toContain('Hi Jane,');
    expect(html).toContain(`bgcolor="${BRAND_RED}"`);
    expect(html).toContain('href="https://portal.example.com/login"');
    expect(html).toContain('>Sign in</a>');
    expect(text).toContain('Sign in: https://portal.example.com/login');
    expect(html).not.toMatch(/partner/i);
  });

  it('falls back to a nameless greeting when displayName is blank', () => {
    const { text } = renderer.render('deactivated', 'zh-CN', {
      displayName: '  ',
    });
    expect(text).toContain(zhCN.email.layout.greetingNoName);
    expect(text).toContain(zhCN.email.deactivated.paragraphs[0]);
  });

  it('rejected: includes the reason only when provided, HTML-escaped', () => {
    const withReason = renderer.render('rejected', 'en', {
      reason: '<script>alert(1)</script>',
    });
    expect(withReason.html).not.toContain('<script>');
    expect(withReason.html).toContain('&lt;script&gt;');
    expect(withReason.text).toContain(en.email.rejected.reasonLabel);

    const without = renderer.render('rejected', 'en', { reason: null });
    expect(without.text).not.toContain(en.email.rejected.reasonLabel);
    expect(without.text).toContain(en.email.rejected.closing);
  });

  it('auth links show the optional fallback code with a label', () => {
    const withCode = renderer.render('auth.magic_link', 'en', {
      signInUrl: 'https://x.example/verify?token=a&type=magiclink',
      code: '12345678',
    });
    expect(withCode.text).toContain(`${en.email.layout.codeLabel}\n12345678`);
    expect(withCode.html).toContain(
      'href="https://x.example/verify?token=a&amp;type=magiclink"',
    );

    const withoutCode = renderer.render('auth.recovery', 'en', {
      resetUrl: 'https://x.example/verify',
    });
    expect(withoutCode.text).not.toContain(en.email.layout.codeLabel);
  });

  it('reauthentication shows the code without a button or label', () => {
    const { html, text } = renderer.render('auth.reauthentication', 'en', {
      code: '99887766',
    });
    expect(html).toContain('99887766');
    expect(html).not.toContain(`bgcolor="${BRAND_RED}"`);
    expect(text).not.toContain(en.email.layout.codeLabel);
  });

  it('fills invite vars into subject and copy', () => {
    const { subject, text } = renderer.render('invite.season', 'zh-CN', {
      displayName: '李雷',
      season: '2026/27',
      activateUrl: 'https://portal.example.com/activate?t=abc',
      validDays: 30,
    });
    expect(subject).toContain('2026/27');
    expect(text).toContain('李雷，您好：');
    expect(text).toContain('30 天内有效');
    expect(text).toContain('https://portal.example.com/activate?t=abc');
  });

  it('admin.instructor_pending links to the admin review page', () => {
    const { subject, html } = renderer.render(
      'admin.instructor_pending',
      'en',
      {
        instructorEmail: 'new@example.com',
        reviewUrl: 'https://portal.example.com/admin/instructors/abc',
      },
    );
    expect(subject).toContain('new@example.com');
    expect(html).toContain(
      'href="https://portal.example.com/admin/instructors/abc"',
    );
  });
});
