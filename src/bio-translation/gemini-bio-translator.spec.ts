import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_KEY_HEADER,
  GeminiBioTranslator,
  GeminiTranslationError,
  buildDraftInstruction,
  buildTranslationInstruction,
  parseSourceLangs,
  type FetchLike,
} from './gemini-bio-translator';
import { PRESERVED_TERMS, TRANSLATION_GLOSSARY } from './translation-glossary';

const API_KEY = 'test-gemini-key';

function reply(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function textReply(text: string) {
  return reply(200, { candidates: [{ content: { parts: [{ text }] } }] });
}

type FetchCall = Parameters<FetchLike>;

function makeTranslator(
  fetchImpl: jest.Mock<ReturnType<FetchLike>, FetchCall>,
  over: Partial<ConstructorParameters<typeof GeminiBioTranslator>[0]> = {},
) {
  return new GeminiBioTranslator({
    apiKey: API_KEY,
    fetch: fetchImpl,
    retryDelayMs: 1,
    ...over,
  });
}

describe('GeminiBioTranslator', () => {
  it('posts a generateContent request with the key in a header, never the URL', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>(() =>
      textReply('我教滑雪。'),
    );
    const translator = makeTranslator(fetchImpl, { model: 'gemini-test' });

    await expect(
      translator.translate({
        text: 'I teach skiing.',
        from: 'en',
        to: 'zh-CN',
      }),
    ).resolves.toBe('我教滑雪。');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent',
    );
    expect(url).not.toContain(API_KEY);
    expect(init.method).toBe('POST');
    expect(init.headers[GEMINI_API_KEY_HEADER]).toBe(API_KEY);
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
    };
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'I teach skiing.' }] },
    ]);
    expect(body.systemInstruction.parts[0].text).toContain(
      'from English into Simplified Chinese',
    );
    expect(init.body).not.toContain(API_KEY);
  });

  it('exposes the configured model id, defaulting to a current Flash model', () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>();
    expect(makeTranslator(fetchImpl, { model: 'gemini-x' }).modelId).toBe(
      'gemini-x',
    );
    expect(makeTranslator(fetchImpl, { model: '  ' }).modelId).toBe(
      DEFAULT_GEMINI_MODEL,
    );
    expect(DEFAULT_GEMINI_MODEL).toMatch(/^gemini-.*flash/);
  });

  it('ignores thought parts and joins the answer text', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>(() =>
      reply(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: 'thinking…', thought: true },
                { text: ' I teach ' },
                { text: 'skiing. ' },
              ],
            },
          },
        ],
      }),
    );

    await expect(
      makeTranslator(fetchImpl).translate({
        text: '我教滑雪。',
        from: 'zh-CN',
        to: 'en',
      }),
    ).resolves.toBe('I teach skiing.');
  });

  it('treats an empty result as a failure without retrying', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>(() =>
      reply(200, { candidates: [{ content: { parts: [{ text: '  ' }] } }] }),
    );

    await expect(
      makeTranslator(fetchImpl).translate({
        text: 'x',
        from: 'en',
        to: 'zh-CN',
      }),
    ).rejects.toThrow('Gemini returned no text');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a response without candidates as a failure', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>(() =>
      reply(200, {}),
    );

    await expect(
      makeTranslator(fetchImpl).translate({
        text: 'x',
        from: 'en',
        to: 'zh-CN',
      }),
    ).rejects.toBeInstanceOf(GeminiTranslationError);
  });

  it('retries 5xx and 429 responses, then succeeds', async () => {
    const fetchImpl = jest
      .fn<ReturnType<FetchLike>, FetchCall>()
      .mockImplementationOnce(() => reply(503, {}))
      .mockImplementationOnce(() => reply(429, {}))
      .mockImplementationOnce(() => textReply('ok'));

    await expect(
      makeTranslator(fetchImpl).translate({
        text: 'x',
        from: 'en',
        to: 'zh-CN',
      }),
    ).resolves.toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after the bounded number of attempts', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>(() =>
      reply(500, { error: { message: 'backend down' } }),
    );

    await expect(
      makeTranslator(fetchImpl, { maxAttempts: 2 }).translate({
        text: 'x',
        from: 'en',
        to: 'zh-CN',
      }),
    ).rejects.toThrow('Gemini HTTP 500: backend down');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry client errors and keeps the key out of the error', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>(() =>
      reply(400, { error: { message: 'API key not valid' } }),
    );

    const error = await makeTranslator(fetchImpl)
      .translate({ text: 'x', from: 'en', to: 'zh-CN' })
      .catch((err: Error) => err);

    expect(error).toBeInstanceOf(GeminiTranslationError);
    expect((error as Error).message).toBe('Gemini HTTP 400: API key not valid');
    expect((error as Error).message).not.toContain(API_KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries network errors', async () => {
    const fetchImpl = jest
      .fn<ReturnType<FetchLike>, FetchCall>()
      .mockImplementationOnce(() => Promise.reject(new Error('fetch failed')))
      .mockImplementationOnce(() => textReply('ok'));

    await expect(
      makeTranslator(fetchImpl).translate({
        text: 'x',
        from: 'en',
        to: 'zh-CN',
      }),
    ).resolves.toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('aborts a request that exceeds the timeout and retries it', async () => {
    const hang = (_url: string, init: FetchCall[1]) =>
      new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    const fetchImpl = jest
      .fn<ReturnType<FetchLike>, FetchCall>()
      .mockImplementationOnce(hang)
      .mockImplementationOnce(() => textReply('ok'));

    await expect(
      makeTranslator(fetchImpl, { timeoutMs: 20 }).translate({
        text: 'x',
        from: 'en',
        to: 'zh-CN',
      }),
    ).resolves.toBe('ok');
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('fails with a timeout once the per-call budget is spent', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>(
      (_url, init) =>
        new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );

    await expect(
      makeTranslator(fetchImpl, { maxAttempts: 5 }).translate({
        text: 'x',
        from: 'en',
        to: 'zh-CN',
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out/);
    expect(fetchImpl.mock.calls.length).toBeLessThan(5);
  });

  it('fails fast when the budget is already exhausted', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>();

    await expect(
      makeTranslator(fetchImpl).translate({
        text: 'x',
        from: 'en',
        to: 'zh-CN',
        timeoutMs: 0,
      }),
    ).rejects.toThrow('Gemini timed out');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('buildTranslationInstruction', () => {
  it('keeps names, certifications, numbers and URLs and asks for the translation only', () => {
    const prompt = buildTranslationInstruction('zh-CN', 'en');

    expect(prompt).toContain(
      "a ski/snowboard instructor's self-description from Simplified Chinese into English",
    );
    expect(prompt).toContain(
      "Keep people's names, certifications (CSIA, CASI, Level N, Course Conductor), numbers and URLs unchanged.",
    );
    expect(prompt).toMatch(/naturally/);
    expect(prompt).toContain('Output only the translation');
  });

  it('includes every glossary entry', () => {
    const prompt = buildTranslationInstruction('en', 'zh-CN');

    for (const entry of TRANSLATION_GLOSSARY) {
      expect(prompt).toContain(`${entry.zh.join(' / ')} = ${entry.en}`);
    }
    expect(prompt).toContain('考证 / 考前培训 = certification exam prep');
    expect(prompt).toContain('跟拍 = photo/video follow-cam');
  });

  it('describes reference names as short labels', () => {
    expect(
      buildTranslationInstruction('en', 'zh-CN', 'reference-name'),
    ).toContain('a short label used by a ski/snowboard school');
  });
});

describe('GeminiBioTranslator.draft', () => {
  const jsonReply = (value: unknown) =>
    textReply(typeof value === 'string' ? value : JSON.stringify(value));

  interface DraftBody {
    systemInstruction: { parts: { text: string }[] };
    contents: { role: string; parts: { text: string }[] }[];
    generationConfig: {
      responseMimeType: string;
      responseSchema: { required: string[] };
    };
  }

  it.each(['refine', 'translate'] as const)(
    'makes one structured-JSON call in %s mode and returns both languages',
    async (mode) => {
      const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>(() =>
        jsonReply({
          en: ' I teach skiing. ',
          zh: '我教滑雪。',
          sourceLangs: ['en'],
        }),
      );

      await expect(
        makeTranslator(fetchImpl, { model: 'gemini-test' }).draft({
          text: 'I teach skiing.',
          mode,
          maxLength: 1000,
        }),
      ).resolves.toEqual({
        en: 'I teach skiing.',
        zh: '我教滑雪。',
        sourceLangs: ['en'],
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toContain('/models/gemini-test:generateContent');
      const body = JSON.parse(init.body) as DraftBody;
      expect(body.contents).toEqual([
        { role: 'user', parts: [{ text: 'I teach skiing.' }] },
      ]);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.generationConfig.responseSchema.required).toEqual([
        'en',
        'zh',
        'sourceLangs',
      ]);
      expect(body.systemInstruction.parts[0].text).toBe(
        buildDraftInstruction(mode, 1000),
      );
    },
  );

  it.each([
    ['invalid JSON', 'not json', /invalid JSON/],
    [
      'a missing language',
      { en: 'Hi', sourceLangs: ['en'] },
      /missing en or zh/,
    ],
    [
      'an empty language',
      { en: 'Hi', zh: '  ', sourceLangs: ['en'] },
      /empty language/,
    ],
    [
      'an over-limit language',
      { en: 'x'.repeat(11), zh: '好', sourceLangs: ['en'] },
      /exceeds 10/,
    ],
    ['missing sourceLangs', { en: 'Hi', zh: '嗨' }, /invalid sourceLangs/],
    [
      'empty sourceLangs',
      { en: 'Hi', zh: '嗨', sourceLangs: [] },
      /invalid sourceLangs/,
    ],
    [
      'an unknown source language',
      { en: 'Hi', zh: '嗨', sourceLangs: ['en', 'fr'] },
      /invalid sourceLangs/,
    ],
    [
      'a non-array sourceLangs',
      { en: 'Hi', zh: '嗨', sourceLangs: 'en' },
      /invalid sourceLangs/,
    ],
  ])('rejects %s without retrying', async (_label, reply, message) => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>(() =>
      jsonReply(reply),
    );
    await expect(
      makeTranslator(fetchImpl).draft({
        text: 'Hi',
        mode: 'refine',
        maxLength: 10,
      }),
    ).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a server error', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>(() =>
      reply(503, { error: { message: 'overloaded' } }),
    );
    await expect(
      makeTranslator(fetchImpl).draft({
        text: 'Hi',
        mode: 'translate',
        maxLength: 1000,
      }),
    ).rejects.toBeInstanceOf(GeminiTranslationError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, FetchCall>(
      (_url, init) =>
        new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    await expect(
      makeTranslator(fetchImpl, { timeoutMs: 20 }).draft({
        text: 'Hi',
        mode: 'refine',
        maxLength: 1000,
      }),
    ).rejects.toThrow(/timed out/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('parseSourceLangs', () => {
  it.each([
    [['en'], ['en']],
    [['zh-CN'], ['zh-CN']],
    [
      ['zh-CN', 'en'],
      ['en', 'zh-CN'],
    ],
    [['en', 'en'], ['en']],
  ])('accepts %j as %j', (input, expected) => {
    expect(parseSourceLangs(input)).toEqual(expected);
  });

  it.each([[[]], [['zh']], [['EN']], [[null]], ['en'], [undefined], [{}]])(
    'rejects %j',
    (input) => {
      expect(() => parseSourceLangs(input)).toThrow(GeminiTranslationError);
    },
  );
});

describe('buildDraftInstruction', () => {
  it('asks refine to polish and produce both languages', () => {
    const prompt = buildDraftInstruction('refine', 1000);
    expect(prompt).toMatch(/Polish the wording/);
    expect(prompt).toMatch(/both English and Simplified Chinese/);
    expect(prompt).not.toMatch(/exactly as written/);
  });

  it('asks translate to keep the wording and fill in only what is missing', () => {
    const prompt = buildDraftInstruction('translate', 1000);
    expect(prompt).toMatch(/exactly as written/);
    expect(prompt).toMatch(/Translate only what is missing/);
    expect(prompt).not.toMatch(/Polish/);
  });

  it.each(['refine', 'translate'] as const)(
    'uses the shared glossary, preserved terms and the length limit (%s)',
    (mode) => {
      const prompt = buildDraftInstruction(mode, 1000);
      for (const entry of TRANSLATION_GLOSSARY) {
        expect(prompt).toContain(`${entry.zh.join(' / ')} = ${entry.en}`);
      }
      expect(prompt).toContain(PRESERVED_TERMS.join(', '));
      expect(prompt).toContain('at most 1000 characters');
      expect(prompt).toMatch(/mix of both/);
      expect(prompt).toContain('"sourceLangs"');
    },
  );
});
