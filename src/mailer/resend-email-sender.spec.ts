import { ConfigService } from '@nestjs/config';
import { ResendEmailSender } from './resend-email-sender';
import type { EmailMessage } from './mailer.types';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

const message: EmailMessage = {
  to: 'jane@example.com',
  subject: 'Hi',
  html: '<p>Hi</p>',
  text: 'Hi',
};

describe('ResendEmailSender', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('is not configured without an API key + from address', () => {
    expect(new ResendEmailSender(configWith({})).isConfigured()).toBe(false);
    expect(
      new ResendEmailSender(
        configWith({ RESEND_API_KEY: 're_x' }),
      ).isConfigured(),
    ).toBe(false);
  });

  it('is configured when both API key and from address are present', () => {
    const sender = new ResendEmailSender(
      configWith({ RESEND_API_KEY: 're_x', MAIL_FROM: 'a@b.com' }),
    );
    expect(sender.isConfigured()).toBe(true);
  });

  it('throws when sending while unconfigured', async () => {
    const sender = new ResendEmailSender(configWith({}));
    await expect(sender.send(message)).rejects.toThrow(/not configured/i);
  });

  it('POSTs to the Resend API and returns the message id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ id: 'resend-123' }),
    });
    global.fetch = fetchMock;

    const sender = new ResendEmailSender(
      configWith({ RESEND_API_KEY: 're_secret', MAIL_FROM: 'Snow <a@b.com>' }),
    );
    const result = await sender.send(message);

    expect(result.id).toBe('resend-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_secret');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: 'Snow <a@b.com>',
      to: ['jane@example.com'],
      subject: 'Hi',
    });
  });

  it('throws with the provider detail on a non-2xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      text: () => Promise.resolve('{"message":"invalid from"}'),
    });

    const sender = new ResendEmailSender(
      configWith({ RESEND_API_KEY: 're_x', MAIL_FROM: 'a@b.com' }),
    );
    await expect(sender.send(message)).rejects.toThrow(/422/);
  });
});
