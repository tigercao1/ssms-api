import { ConfigService } from '@nestjs/config';
import { MailerConfig } from './mailer.config';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('MailerConfig', () => {
  it('defaults to the dev portal, info@ssnow.club and the hosted PNG logo', () => {
    const config = new MailerConfig(configWith({}));
    expect(config.portalUrl).toBe('http://localhost:5173');
    expect(config.replyTo).toBe('info@ssnow.club');
    expect(config.logoUrl).toBe('https://app.ssnow.club/email-logo.png');
  });

  it('defaults the portal to app.ssnow.club in production', () => {
    const config = new MailerConfig(configWith({ NODE_ENV: 'production' }));
    expect(config.portalUrl).toBe('https://app.ssnow.club');
  });

  it('reads PORTAL_URL, MAIL_REPLY_TO and EMAIL_LOGO_URL, trimming trailing slashes', () => {
    const config = new MailerConfig(
      configWith({
        NODE_ENV: 'production',
        PORTAL_URL: ' https://portal.example.com// ',
        MAIL_REPLY_TO: 'help@example.com',
        EMAIL_LOGO_URL: 'https://cdn.example.com/logo.png',
      }),
    );
    expect(config.portalUrl).toBe('https://portal.example.com');
    expect(config.portalLink('/login')).toBe(
      'https://portal.example.com/login',
    );
    expect(config.replyTo).toBe('help@example.com');
    expect(config.logoUrl).toBe('https://cdn.example.com/logo.png');
  });

  it('treats blank values as unset', () => {
    const config = new MailerConfig(
      configWith({ PORTAL_URL: '  ', MAIL_REPLY_TO: '' }),
    );
    expect(config.portalUrl).toBe('http://localhost:5173');
    expect(config.replyTo).toBe('info@ssnow.club');
  });
});
