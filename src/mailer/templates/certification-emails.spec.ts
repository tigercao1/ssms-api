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
      'Your membership card for CASI Park Level 1 expires on 2026-11-30',
    ],
    [
      'certification.expired',
      'en',
      'Your membership card for CASI Park Level 1 has expired',
    ],
    [
      'certification.expiring',
      'zh-CN',
      '您用于 CASI 公园 1 级 的会员卡将于 2026-11-30 到期',
    ],
    ['certification.expired', 'zh-CN', '您用于 CASI 公园 1 级 的会员卡已过期'],
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

describe('certification rejected email', () => {
  const rejected = {
    displayName: 'Lin Wei',
    org: 'casi' as const,
    track: 'park' as const,
    level: 1,
    reason: '  Blurry photo  ',
    uploadUrl: 'https://portal.example.com/onboarding',
  };

  it.each([
    [
      'en',
      'Please upload your membership card for CASI Park Level 1 again',
      'A note from our team: Blurry photo',
    ],
    [
      'zh-CN',
      '请重新上传您用于 CASI 公园 1 级 的会员卡',
      '团队备注： Blurry photo',
    ],
  ] as const)(
    'in %s names the certification, quotes the note and links to re-upload',
    (language, subject, note) => {
      const email = renderer.render(
        'certification.rejected',
        language,
        rejected,
      );
      expect(email.subject).toBe(subject);
      expect(email.text).toContain(note);
      expect(email.html).toContain(
        'href="https://portal.example.com/onboarding"',
      );
      expect(email.text).toContain('https://portal.example.com/onboarding');
    },
  );

  it('renders both languages when bilingual', () => {
    const email = renderer.render(
      'certification.rejected',
      'bilingual',
      rejected,
    );
    expect(email.subject).toContain('CASI Park Level 1');
    expect(email.subject).toContain('CASI 公园 1 级');
    expect(email.text).toContain('A note from our team: Blurry photo');
    expect(email.text).toContain('团队备注： Blurry photo');
  });

  it('names the certification without a level and omits a blank note', () => {
    const email = renderer.render('certification.rejected', 'en', {
      ...rejected,
      org: 'csia',
      track: 'carving',
      level: null,
      reason: '   ',
    });
    expect(email.subject).toBe(
      'Please upload your membership card for CSIA Carving again',
    );
    expect(email.text).not.toContain('A note from our team');
  });

  it('samples a re-upload link and a note', () => {
    const sample = renderer.sampleVars('certification.rejected');
    expect(sample.uploadUrl).toBe('https://portal.example.com/onboarding');
    expect(sample.reason).toBeTruthy();
  });
});
