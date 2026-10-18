import {
  OpenRouterClient,
  OpenRouterError,
  buildRequestBody,
} from './openrouter.client';

describe('buildRequestBody', () => {
  it('sends the auto router with its plugin settings', () => {
    const body = buildRequestBody({
      routing: {
        model: 'openrouter/auto',
        allowedModels: ['google/*'],
        costTier: 'low',
      },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.model).toBe('openrouter/auto');
    expect(body.plugins).toEqual([
      { id: 'auto-router', allowed_models: ['google/*'], cost_tier: 'low' },
    ]);
    expect(body.provider).toEqual({
      data_collection: 'deny',
      require_parameters: false,
    });
  });

  it('sends a fallback list as models and requires structured-output support', () => {
    const body = buildRequestBody({
      routing: {
        model: 'google/gemini-2.5-flash',
        fallbacks: ['openai/gpt-4.1-mini'],
      },
      messages: [{ role: 'user', content: 'hi' }],
      jsonSchema: { name: 'x', schema: { type: 'object' } },
      zeroDataRetention: true,
    });
    expect(body.models).toEqual([
      'google/gemini-2.5-flash',
      'openai/gpt-4.1-mini',
    ]);
    expect(body.model).toBeUndefined();
    expect(body.provider).toEqual({
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
    });
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true },
    });
  });
});

describe('OpenRouterClient', () => {
  const ok = (json: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(json),
    });

  it('returns the model the router picked', async () => {
    const client = new OpenRouterClient({
      apiKey: 'k',
      fetch: () =>
        ok({
          id: 'gen-1',
          model: 'google/gemini-2.5-flash',
          choices: [{ message: { content: 'Bonjour' } }],
          usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.00001 },
        }),
    });
    const result = await client.chat({
      routing: { model: 'openrouter/auto' },
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(result).toEqual({
      text: 'Bonjour',
      model: 'google/gemini-2.5-flash',
      generationId: 'gen-1',
      usage: { promptTokens: 3, completionTokens: 1, cost: 0.00001 },
    });
  });

  it('marks rate limits retryable and bad requests not', async () => {
    const failing = (status: number) =>
      new OpenRouterClient({
        apiKey: 'k',
        fetch: () =>
          Promise.resolve({
            ok: false,
            status,
            json: () =>
              Promise.resolve({ error: { message: 'x', code: status } }),
          }),
      });
    await expect(
      failing(429).chat({ routing: { model: 'm' }, messages: [] }),
    ).rejects.toMatchObject({ retryable: true });
    await expect(
      failing(400).chat({ routing: { model: 'm' }, messages: [] }),
    ).rejects.toBeInstanceOf(OpenRouterError);
    await expect(
      failing(400).chat({ routing: { model: 'm' }, messages: [] }),
    ).rejects.toMatchObject({ retryable: false });
  });
});
