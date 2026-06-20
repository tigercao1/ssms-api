import { I18nNotificationRenderer } from './i18n-notification-renderer';
import { en } from '../../i18n';
import { zhCN } from '../../i18n';

const renderer = new I18nNotificationRenderer();

describe('I18nNotificationRenderer', () => {
  it('renders English copy from the catalog for an approved notification', () => {
    const msg = renderer.render({
      to: 'jane@example.com',
      type: 'approved',
      language: 'en',
      displayName: 'Jane',
      portalUrl: 'https://portal.example.com',
    });
    expect(msg.to).toBe('jane@example.com');
    expect(msg.subject).toBe(en.notification.approved.subject);
    expect(msg.text).toContain(en.notification.approved.body);
    expect(msg.text).toContain('Jane');
    expect(msg.text).toContain('https://portal.example.com');
    expect(msg.html).toContain('<p>');
  });

  it('picks Simplified Chinese copy when preferred_language is zh-CN', () => {
    const msg = renderer.render({
      to: 'li@example.com',
      type: 'deactivated',
      language: 'zh-CN',
    });
    expect(msg.subject).toBe(zhCN.notification.deactivated.subject);
    expect(msg.text).toContain(zhCN.notification.deactivated.body);
  });

  it('fires the correct template per type (rejected uses rejected copy)', () => {
    const msg = renderer.render({
      to: 'x@example.com',
      type: 'rejected',
      language: 'en',
    });
    expect(msg.subject).toBe(en.notification.rejected.subject);
    expect(msg.subject).not.toBe(en.notification.approved.subject);
  });

  it('falls back to English when language is missing/unknown', () => {
    const missing = renderer.render({
      to: 'x@example.com',
      type: 'approved',
      language: null,
    });
    expect(missing.subject).toBe(en.notification.approved.subject);

    const unknown = renderer.render({
      to: 'x@example.com',
      type: 'approved',
      // simulate an out-of-range value coming off the profile
      language: 'fr' as unknown as 'en',
    });
    expect(unknown.subject).toBe(en.notification.approved.subject);
  });

  it('includes the rejection reason only when provided', () => {
    const withReason = renderer.render({
      to: 'x@example.com',
      type: 'rejected',
      language: 'en',
      reason: 'missing certifications',
    });
    expect(withReason.text).toContain('missing certifications');
    expect(withReason.text).toContain(en.notification.rejected.reasonLabel);

    const without = renderer.render({
      to: 'x@example.com',
      type: 'rejected',
      language: 'en',
    });
    expect(without.text).not.toContain(
      `${en.notification.rejected.reasonLabel}:`,
    );
  });

  it('omits greeting name when displayName is absent', () => {
    const msg = renderer.render({
      to: 'x@example.com',
      type: 'approved',
      language: 'en',
    });
    expect(msg.text.startsWith(`${en.notification.approved.greeting},`)).toBe(
      true,
    );
  });

  it('escapes HTML in interpolated values', () => {
    const msg = renderer.render({
      to: 'x@example.com',
      type: 'rejected',
      language: 'en',
      reason: '<script>alert(1)</script>',
    });
    expect(msg.html).not.toContain('<script>');
    expect(msg.html).toContain('&lt;script&gt;');
  });
});
