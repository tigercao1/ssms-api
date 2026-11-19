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

  it.each([
    [
      'Serendipity Snow <noreply@contact.ssnow.club>',
      'noreply@contact.ssnow.club',
    ],
    ['noreply@contact.ssnow.club', 'noreply@contact.ssnow.club'],
    [undefined, 'info@ssnow.club'],
  ])('takes the sender address from MAIL_FROM %p', (from, address) => {
    const config = new MailerConfig(configWith({ MAIL_FROM: from }));
    expect(config.senderAddress).toBe(address);
  });

  it('uses MAIL_FROM_BOOKINGS and MAIL_REPLY_TO_BOOKINGS for booking templates only', () => {
    const config = new MailerConfig(
      configWith({
        MAIL_FROM: 'Snow <noreply@contact.ssnow.club>',
        MAIL_FROM_BOOKINGS: ' Bookings <bookings@contact.ssnow.club> ',
        MAIL_REPLY_TO_BOOKINGS: 'bookings@ssnow.club',
      }),
    );
    expect(config.mailboxFor('booking.confirmed.customer')).toEqual({
      from: 'Bookings <bookings@contact.ssnow.club>',
      replyTo: 'bookings@ssnow.club',
    });
    expect(config.senderAddressFor('booking.cancelled.instructor')).toBe(
      'bookings@contact.ssnow.club',
    );
    expect(config.mailboxFor('approved')).toEqual({});
    expect(config.senderAddressFor('approved')).toBe(
      'noreply@contact.ssnow.club',
    );
  });

  it('falls back to the default mailbox for booking templates when the booking vars are unset', () => {
    const config = new MailerConfig(
      configWith({
        MAIL_FROM: 'Snow <noreply@contact.ssnow.club>',
        MAIL_FROM_BOOKINGS: ' ',
      }),
    );
    expect(config.mailboxFor('booking.rescheduled.customer')).toEqual({});
    expect(config.senderAddressFor('booking.rescheduled.customer')).toBe(
      'noreply@contact.ssnow.club',
    );
  });
});
