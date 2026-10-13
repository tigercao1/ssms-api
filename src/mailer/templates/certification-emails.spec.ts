import { ConfigService } from '@nestjs/config';
import { MailerConfig } from '../mailer.config';
import { EmailRenderer } from './email-renderer';

const renderer = new EmailRenderer(
  new MailerConfig({
    get: (key: string) => ({ PORTAL_URL: 'https://portal.example.com' })[key],
  } as unknown as ConfigService),
);

const vars = {
  displayName: 'Lin Wei',
  org: 'casi' as const,
  track: 'park' as const,
  level: 1,
  validUntil: '2026-11-30',
  uploadUrl: 'https://portal.example.com/onboarding',
};

describe('certification expiry emails', () => {
  it.each([
    [
      'certification.expiring',
      'en',
      'Your CASI Park Level 1 certification expires on 2026-11-30',
    ],
    [
      'certification.expired',
      'en',
      'Your CASI Park Level 1 certification has expired',
    ],
    [
      'certification.expiring',
      'zh-CN',
      '您的 CASI 公园 1 级 证书将于 2026-11-30 到期',
    ],
    ['certification.expired', 'zh-CN', '您的 CASI 公园 1 级 证书已过期'],
  ] as const)(
    '%s in %s names the certification and links to re-upload',
    (template, language, subject) => {
      const email = renderer.render(template, language, vars);
      expect(email.subject).toBe(subject);
      expect(email.html).toContain(
        'href="https://portal.example.com/onboarding"',
      );
      expect(email.text).toContain('https://portal.example.com/onboarding');
    },
  );

  it.each([
    ['regular', 'CSIA Level 3', 'CSIA 3 级'],
    ['carving', 'CSIA Carving Level 3', 'CSIA 刻滑 3 级'],
  ] as const)('labels the %s track', (track, enLabel, zhLabel) => {
    const email = renderer.render('certification.expiring', 'bilingual', {
      ...vars,
      org: 'csia',
      track,
      level: 3,
    });
    expect(email.subject).toContain(enLabel);
    expect(email.subject).toContain(zhLabel);
  });

  it('samples a re-upload link on the portal', () => {
    expect(renderer.sampleVars('certification.expired').uploadUrl).toBe(
      'https://portal.example.com/onboarding',
    );
  });
});
