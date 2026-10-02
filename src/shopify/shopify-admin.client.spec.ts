import { ConfigService } from '@nestjs/config';
import {
  MAX_THROTTLE_ATTEMPTS,
  MAX_THROTTLE_WAIT_MS,
  MAX_TRANSPORT_ATTEMPTS,
  ShopifyAdminClient,
} from './shopify-admin.client';
import {
  ShopifyAuthError,
  ShopifyConfigError,
  ShopifyGraphqlError,
  ShopifyHttpError,
  ShopifyThrottledError,
} from './shopify.errors';

const TOKEN_URL = 'https://acme.myshopify.com/admin/oauth/access_token';
const GRAPHQL_URL = 'https://acme.myshopify.com/admin/api/2026-07/graphql.json';

const fullEnv = {
  SHOPIFY_SHOP: 'acme',
  SHOPIFY_CLIENT_ID: 'client-id',
  SHOPIFY_CLIENT_SECRET: 'client-secret',
};

function configWith(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokenResponse(token: string, expiresIn = 86399): Response {
  return jsonResponse({
    access_token: token,
    scope: 'write_metaobjects',
    expires_in: expiresIn,
  });
}

function cost(currentlyAvailable: number, requestedQueryCost = 10) {
  return {
    cost: {
      requestedQueryCost,
      actualQueryCost: requestedQueryCost,
      throttleStatus: {
        maximumAvailable: 2000,
        currentlyAvailable,
        restoreRate: 100,
      },
    },
  };
}

function okResponse(data: unknown, available = 1990): Response {
  return jsonResponse({ data, extensions: cost(available) });
}

function throttledResponse(requested = 500, available = 100): Response {
  return jsonResponse({
    errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
    extensions: {
      cost: {
        requestedQueryCost: requested,
        actualQueryCost: null,
        throttleStatus: {
          maximumAvailable: 2000,
          currentlyAvailable: available,
          restoreRate: 100,
        },
      },
    },
  });
}

type Responder = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response>;

function setup(options: { env?: Record<string, string | undefined> } = {}) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const queue: Responder[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const next = queue.shift();
    if (!next) {
      throw new Error(`unexpected fetch to ${url}`);
    }
    return Promise.resolve(next(url, init ?? {}));
  });
  const client = new ShopifyAdminClient(configWith(options.env ?? fullEnv), {
    fetch: fetchMock as unknown as typeof fetch,
    now: () => clock,
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });
  return {
    client,
    calls,
    sleeps,
    fetchMock,
    advance: (ms: number) => {
      clock += ms;
    },
    respond: (...responders: (Response | Responder)[]) => {
      for (const r of responders) {
        queue.push(typeof r === 'function' ? r : () => r);
      }
    },
    graphqlCalls: () => calls.filter((c) => c.url === GRAPHQL_URL),
    tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL),
  };
}

function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name];
}

describe('ShopifyAdminClient', () => {
  it('requests a client-credentials token and sends it on the GraphQL call', async () => {
    const t = setup();
    t.respond(tokenResponse('tok-1'), okResponse({ shop: { name: 'Acme' } }));

    const data = await t.client.graphql<{ shop: { name: string } }>(
      'query { shop { name } }',
      { a: 1 },
    );

    expect(data).toEqual({ shop: { name: 'Acme' } });
    const [tokenCall] = t.tokenCalls();
    expect(tokenCall.init.method).toBe('POST');
    expect(headerOf(tokenCall.init, 'Content-Type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(
      Object.fromEntries(new URLSearchParams(tokenCall.init.body as string)),
    ).toEqual({
      grant_type: 'client_credentials',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });
    const [gqlCall] = t.graphqlCalls();
    expect(headerOf(gqlCall.init, 'X-Shopify-Access-Token')).toBe('tok-1');
    expect(JSON.parse(gqlCall.init.body as string)).toEqual({
      query: 'query { shop { name } }',
      variables: { a: 1 },
    });
  });

  it('reuses the cached token across calls', async () => {
    const t = setup();
    t.respond(
      tokenResponse('tok-1'),
      okResponse({ n: 1 }),
      okResponse({ n: 2 }),
    );

    await t.client.graphql('query { a }');
    t.advance(60 * 60 * 1000);
    await t.client.graphql('query { b }');

    expect(t.tokenCalls()).toHaveLength(1);
    expect(
      t.graphqlCalls().map((c) => headerOf(c.init, 'X-Shopify-Access-Token')),
    ).toEqual(['tok-1', 'tok-1']);
  });

  it('shares one token request between concurrent calls', async () => {
    const t = setup();
    t.respond(
      tokenResponse('tok-1'),
      okResponse({ n: 1 }),
      okResponse({ n: 2 }),
    );

    await Promise.all([
      t.client.graphql('query { a }'),
      t.client.graphql('query { b }'),
    ]);

    expect(t.tokenCalls()).toHaveLength(1);
  });

  it('refreshes the token shortly before it expires', async () => {
    const t = setup();
    t.respond(
      tokenResponse('tok-1'),
      okResponse({ n: 1 }),
      tokenResponse('tok-2'),
      okResponse({ n: 2 }),
    );

    await t.client.graphql('query { a }');
    t.advance((86399 - 30) * 1000);
    await t.client.graphql('query { b }');

    expect(t.tokenCalls()).toHaveLength(2);
    expect(headerOf(t.graphqlCalls()[1].init, 'X-Shopify-Access-Token')).toBe(
      'tok-2',
    );
  });

  it('refreshes the token once and retries after a 401', async () => {
    const t = setup();
    t.respond(
      tokenResponse('tok-1'),
      jsonResponse({ errors: 'Invalid API key or access token' }, 401),
      tokenResponse('tok-2'),
      okResponse({ ok: true }),
    );

    await expect(t.client.graphql('query { a }')).resolves.toEqual({
      ok: true,
    });
    expect(
      t.graphqlCalls().map((c) => headerOf(c.init, 'X-Shopify-Access-Token')),
    ).toEqual(['tok-1', 'tok-2']);
  });

  it('gives up with an HTTP error when the refreshed token is also rejected', async () => {
    const t = setup();
    t.respond(
      tokenResponse('tok-1'),
      jsonResponse({ errors: 'no' }, 401),
      tokenResponse('tok-2'),
      jsonResponse({ errors: 'still no' }, 401),
    );

    const error = await failure(t.client.graphql('query { a }'));
    expect(error).toBeInstanceOf(ShopifyHttpError);
    expect((error as ShopifyHttpError).status).toBe(401);
    expect(t.tokenCalls()).toHaveLength(2);
  });

  it('throws an auth error when the token request is refused', async () => {
    const t = setup();
    t.respond(jsonResponse({ error: 'invalid_client' }, 400));

    const error = await failure(t.client.graphql('query { a }'));
    expect(error).toBeInstanceOf(ShopifyAuthError);
    expect((error as ShopifyAuthError).status).toBe(400);
    expect(t.graphqlCalls()).toHaveLength(0);
  });

  it('throws an auth error when the token response has no token', async () => {
    const t = setup();
    t.respond(jsonResponse({ scope: 'x' }));

    await expect(t.client.graphql('query { a }')).rejects.toBeInstanceOf(
      ShopifyAuthError,
    );
  });

  it('waits and retries when a 200 response is THROTTLED, then succeeds', async () => {
    const t = setup();
    t.respond(
      tokenResponse('tok-1'),
      throttledResponse(500, 100),
      okResponse({ ok: true }),
    );

    await expect(t.client.graphql('query { a }')).resolves.toEqual({
      ok: true,
    });
    expect(t.graphqlCalls()).toHaveLength(2);
    expect(t.sleeps).toEqual([4000]);
  });

  it('caps the throttle wait', async () => {
    const t = setup();
    t.respond(
      tokenResponse('tok-1'),
      throttledResponse(1990, 0),
      okResponse({ ok: true }),
    );

    await t.client.graphql('query { a }');

    expect(t.sleeps[0]).toBe(MAX_THROTTLE_WAIT_MS);
  });

  it('gives up after the maximum number of THROTTLED attempts', async () => {
    const t = setup();
    t.respond(tokenResponse('tok-1'));
    for (let i = 0; i < MAX_THROTTLE_ATTEMPTS; i++) {
      t.respond(throttledResponse());
    }

    const error = await failure(t.client.graphql('query { a }'));
    expect(error).toBeInstanceOf(ShopifyThrottledError);
    expect(t.graphqlCalls()).toHaveLength(MAX_THROTTLE_ATTEMPTS);
  });

  it('pauses before a request when the bucket cannot cover the last query cost', async () => {
    const t = setup();
    t.respond(
      tokenResponse('tok-1'),
      jsonResponse({ data: { n: 1 }, extensions: cost(20, 220) }),
      okResponse({ n: 2 }),
    );

    await t.client.graphql('query { a }');
    await t.client.graphql('query { b }');

    expect(t.sleeps).toEqual([2000]);
  });

  it('retries HTTP 5xx with exponential backoff', async () => {
    const t = setup();
    t.respond(
      tokenResponse('tok-1'),
      new Response('oops', { status: 502 }),
      new Response('oops', { status: 503 }),
      okResponse({ ok: true }),
    );

    await expect(t.client.graphql('query { a }')).resolves.toEqual({
      ok: true,
    });
    expect(t.sleeps).toEqual([500, 1000]);
  });

  it('retries network errors and gives up after the maximum attempts', async () => {
    const t = setup();
    t.respond(tokenResponse('tok-1'));
    for (let i = 0; i < MAX_TRANSPORT_ATTEMPTS; i++) {
      t.respond(() => {
        throw new TypeError('fetch failed');
      });
    }

    const error = await failure(t.client.graphql('query { a }'));
    expect(error).toBeInstanceOf(ShopifyHttpError);
    expect((error as ShopifyHttpError).status).toBeUndefined();
    expect(t.graphqlCalls()).toHaveLength(MAX_TRANSPORT_ATTEMPTS);
    expect(t.sleeps).toEqual([500, 1000, 2000]);
  });

  it('gives up on persistent 5xx after the maximum attempts', async () => {
    const t = setup();
    t.respond(tokenResponse('tok-1'));
    for (let i = 0; i < MAX_TRANSPORT_ATTEMPTS; i++) {
      t.respond(new Response('down', { status: 500 }));
    }

    const error = await failure(t.client.graphql('query { a }'));
    expect(error).toBeInstanceOf(ShopifyHttpError);
    expect((error as ShopifyHttpError).status).toBe(500);
    expect((error as ShopifyHttpError).detail).toBe('down');
  });

  it('does not retry other 4xx responses', async () => {
    const t = setup();
    t.respond(tokenResponse('tok-1'), new Response('nope', { status: 403 }));

    const error = await failure(t.client.graphql('query { a }'));
    expect(error).toBeInstanceOf(ShopifyHttpError);
    expect((error as ShopifyHttpError).status).toBe(403);
    expect(t.graphqlCalls()).toHaveLength(1);
  });

  it('throws a typed error carrying non-throttle GraphQL errors', async () => {
    const t = setup();
    const errors = [
      {
        message: "Field 'nope' doesn't exist",
        extensions: { code: 'undefinedField' },
      },
    ];
    t.respond(tokenResponse('tok-1'), jsonResponse({ errors }));

    const error = await failure(t.client.graphql('query { nope }'));
    expect(error).toBeInstanceOf(ShopifyGraphqlError);
    expect(error).not.toBeInstanceOf(ShopifyThrottledError);
    expect((error as ShopifyGraphqlError).errors).toEqual(errors);
    expect(t.graphqlCalls()).toHaveLength(1);
  });

  it('throws when the response has neither data nor errors', async () => {
    const t = setup();
    t.respond(tokenResponse('tok-1'), jsonResponse({ data: null }));

    await expect(t.client.graphql('query { a }')).rejects.toBeInstanceOf(
      ShopifyGraphqlError,
    );
  });

  it('does not touch config or network until first use, then reports missing config', async () => {
    const t = setup({ env: { SHOPIFY_SHOP: 'acme' } });

    expect(t.fetchMock).not.toHaveBeenCalled();
    const error = await failure(t.client.graphql('query { a }'));
    expect(error).toBeInstanceOf(ShopifyConfigError);
    expect((error as ShopifyConfigError).missing).toEqual([
      'SHOPIFY_CLIENT_ID',
      'SHOPIFY_CLIENT_SECRET',
    ]);
    expect(t.fetchMock).not.toHaveBeenCalled();
  });

  it('uses global fetch by default', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(tokenResponse('tok-1'))
      .mockResolvedValueOnce(okResponse({ ok: true }));
    global.fetch = fetchMock;
    try {
      const client = new ShopifyAdminClient(configWith(fullEnv));
      await expect(client.graphql('query { a }')).resolves.toEqual({
        ok: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
