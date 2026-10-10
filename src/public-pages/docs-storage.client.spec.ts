import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  DOCS_WORKER_TIMEOUT_MS,
  HttpDocsStorageClient,
} from './docs-storage.client';

const TOKEN = 'internal-token';

function client(env: Record<string, string | undefined>) {
  const config = { get: (key: string) => env[key] } as ConfigService;
  return new HttpDocsStorageClient(config);
}

describe('HttpDocsStorageClient', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  const configured = () =>
    client({
      DOCS_WORKER_URL: 'https://worker.test/',
      DOCS_INTERNAL_TOKEN: TOKEN,
    });

  function lastCall(): [string, RequestInit] {
    return fetchMock.mock.calls.at(-1) as [string, RequestInit];
  }

  it('is configured only when the token is set', () => {
    expect(configured().isConfigured()).toBe(true);
    expect(client({}).isConfigured()).toBe(false);
    expect(client({ DOCS_INTERNAL_TOKEN: '' }).isConfigured()).toBe(false);
  });

  it('builds public URLs from the Worker URL, or the public base override', () => {
    expect(client({}).publicUrl('faq')).toBe('https://docs.ssnow.club/faq');
    expect(configured().publicUrl('faq')).toBe('https://worker.test/faq');
    expect(
      client({
        DOCS_WORKER_URL: 'https://worker.test',
        DOCS_PUBLIC_BASE_URL: 'https://pages.test/',
      }).publicUrl('faq'),
    ).toBe('https://pages.test/faq');
  });

  it('PUTs the bytes with the bearer token and a timeout', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const body = Buffer.from('<h1>hi</h1>');
    await configured().put('drafts/faq.html', body);
    const [url, init] = lastCall();
    expect(url).toBe('https://worker.test/_internal/objects/drafts/faq.html');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(Buffer.from(init.body as Uint8Array)).toEqual(body);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(DOCS_WORKER_TIMEOUT_MS).toBe(10_000);
  });

  it('GET returns the bytes, or null on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<h1>hi</h1>'));
    await expect(configured().get('drafts/faq.html')).resolves.toEqual(
      Buffer.from('<h1>hi</h1>'),
    );
    expect(lastCall()[1].method).toBe('GET');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(configured().get('drafts/faq.html')).resolves.toBeNull();
  });

  it('GET maps a broken body stream to 502', async () => {
    const res = new Response('x');
    jest.spyOn(res, 'arrayBuffer').mockRejectedValue(new Error('reset'));
    fetchMock.mockResolvedValue(res);
    await expect(configured().get('drafts/faq.html')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('DELETE treats 204 and 404 as success', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await configured().delete('published/faq.html');
    expect(lastCall()[1].method).toBe('DELETE');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(
      configured().delete('published/faq.html'),
    ).resolves.toBeUndefined();
  });

  it.each([401, 413, 500])('maps a %s response to 502', async (status) => {
    fetchMock.mockResolvedValue(new Response('nope', { status }));
    await expect(
      configured().put('drafts/faq.html', Buffer.from('x')),
    ).rejects.toThrow(new BadGatewayException('Docs storage is unavailable'));
  });

  it('maps a network error or timeout to 502', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(configured().delete('drafts/faq.html')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('refuses to call the Worker without a token', async () => {
    await expect(client({}).get('drafts/faq.html')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
