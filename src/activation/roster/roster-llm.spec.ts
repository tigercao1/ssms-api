import { DEFAULT_GEMINI_MODEL } from '../../bio-translation/gemini-bio-translator';
import { parseRosterCsv } from './roster-csv';
import { rosterCsv } from './roster-fixtures.test-util';
import {
  GeminiRosterNormalizer,
  LLM_MIN_CONFIDENCE,
  RosterLlmError,
  buildLlmRequest,
  buildNormalizationInstruction,
  validateLlmResult,
  type RosterLlmRequest,
} from './roster-llm';

const REQUEST: RosterLlmRequest = {
  certifications: 'CASI L3 Partial (Please specify in "Other"), Td',
  certificationDetails: '2025 hill',
  locations: 'MSL, Ottawa Region',
  unresolvedCertifications: [
    'CASI L3 Partial (Please specify in "Other")',
    'Td',
  ],
  unresolvedLocations: ['Ottawa Region'],
};

const PARTIAL = {
  org: 'casi',
  track: 'regular',
  level: 3,
  isPartial: true,
  partialComponents: ['riding'],
};

function item(value: string, certification: unknown, confidence = 0.9) {
  return { value, certification, confidence, reason: 'stated' };
}

describe('validateLlmResult', () => {
  it('accepts valid, confident answers to requested values', () => {
    expect(
      validateLlmResult(
        {
          certifications: [
            item(REQUEST.unresolvedCertifications[0], PARTIAL),
            item('Td', null),
          ],
          locations: [
            {
              value: 'Ottawa Region',
              key: 'teaching_location.tremblant',
              confidence: 0.95,
              reason: 'near',
            },
          ],
        },
        REQUEST,
      ),
    ).toEqual({
      certifications: [
        { value: REQUEST.unresolvedCertifications[0], certification: PARTIAL },
      ],
      trainerStatus: [],
      locations: [
        { value: 'Ottawa Region', key: 'teaching_location.tremblant' },
      ],
      rejected: [{ value: 'Td', reason: 'no certification' }],
    });
  });

  it.each([
    ['partial park', { ...PARTIAL, track: 'park', level: 1 }],
    ['level 5', { ...PARTIAL, level: 5 }],
    ['csia component on casi', { ...PARTIAL, partialComponents: ['ski'] }],
    ['partial without components', { ...PARTIAL, partialComponents: [] }],
    [
      'carving for csia',
      {
        ...PARTIAL,
        org: 'csia',
        track: 'carving',
        isPartial: false,
        partialComponents: [],
      },
    ],
    ['string', 'CASI L3'],
  ])('rejects a certification that breaks migration 010: %s', (_l, bad) => {
    expect(
      validateLlmResult(
        { certifications: [item('Td', bad)], locations: [] },
        REQUEST,
      ).rejected,
    ).toContainEqual({ value: 'Td', reason: 'violates certification rules' });
  });

  it.each([
    [
      { ...item('Td', PARTIAL), confidence: LLM_MIN_CONFIDENCE - 0.01 },
      /^low confidence/,
    ],
    [{ ...item('Td', PARTIAL), confidence: 1.5 }, /^invalid confidence$/],
    [{ ...item('Td', PARTIAL), confidence: '0.9' }, /^invalid confidence$/],
    [{ ...item('Td', PARTIAL), reason: 7 }, /^invalid reason$/],
    [{ ...item('Td', PARTIAL), reason: 'x'.repeat(201) }, /^invalid reason$/],
  ])('rejects %j', (bad, reason) => {
    const result = validateLlmResult(
      { certifications: [bad], locations: [] },
      REQUEST,
    );
    expect(result.certifications).toEqual([]);
    expect(result.rejected.find((r) => r.value === 'Td')?.reason).toMatch(
      reason,
    );
  });

  describe('trainer development', () => {
    const TRAINER = {
      discipline: 'snowboard',
      rookieSessionCompleted: true,
      trainerExamPassed: true,
      trainerLevel: 1,
    };
    const answer = (trainer: unknown, certification: unknown = null) => ({
      certifications: [{ ...item('Td', certification), trainer }],
      locations: [],
    });

    it('accepts trainer level 1 in the discipline of the row org', () => {
      const result = validateLlmResult(answer(TRAINER), REQUEST);
      expect(result.trainerStatus).toEqual([
        { value: 'Td', trainerStatus: TRAINER },
      ]);
      expect(result.certifications).toEqual([]);
      expect(result.rejected.map((r) => r.value)).not.toContain('Td');
    });

    it('accepts a certification and a trainer status for the same value', () => {
      const full = { ...PARTIAL, isPartial: false, partialComponents: [] };
      const result = validateLlmResult(answer(TRAINER, full), REQUEST);
      expect(result.certifications).toEqual([
        { value: 'Td', certification: full },
      ]);
      expect(result.trainerStatus).toEqual([
        { value: 'Td', trainerStatus: TRAINER },
      ]);
    });

    it.each([
      ['another discipline', { ...TRAINER, discipline: 'ski' }],
      ['trainer level 2', { ...TRAINER, trainerLevel: 2 }],
      ['no rookie session', { ...TRAINER, rookieSessionCompleted: false }],
      ['trainer exam not passed', { ...TRAINER, trainerExamPassed: false }],
      ['not an object', 'TD'],
    ])('rejects %s', (_label, trainer) => {
      const result = validateLlmResult(answer(trainer), REQUEST);
      expect(result.trainerStatus).toEqual([]);
      expect(result.rejected).toContainEqual({
        value: 'Td',
        reason: 'violates trainer rules',
      });
    });

    it('rejects any discipline when the row names both orgs', () => {
      const result = validateLlmResult(answer(TRAINER), {
        ...REQUEST,
        certifications: 'CSIA L2, CASI L1, Td',
      });
      expect(result.trainerStatus).toEqual([]);
      expect(result.rejected).toContainEqual({
        value: 'Td',
        reason: 'violates trainer rules',
      });
    });

    it('rejects a trainer status alongside an invalid certification', () => {
      const result = validateLlmResult(
        answer(TRAINER, { ...PARTIAL, level: 5 }),
        REQUEST,
      );
      expect(result.trainerStatus).toEqual([]);
      expect(result.rejected).toContainEqual({
        value: 'Td',
        reason: 'violates certification rules',
      });
    });
  });

  it('rejects location keys outside the allowed list, null keys and low confidence', () => {
    const loc = (key: unknown, confidence = 0.9) => ({
      certifications: [],
      locations: [{ value: 'Ottawa Region', key, confidence, reason: 'r' }],
    });
    const reasonFor = (output: unknown) =>
      validateLlmResult(output, REQUEST).rejected.find(
        (r) => r.value === 'Ottawa Region',
      )?.reason;
    expect(reasonFor(loc('teaching_location.ottawa'))).toBe(
      'location key not allowed',
    );
    expect(reasonFor(loc(42))).toBe('location key not allowed');
    expect(reasonFor(loc(null))).toBe('no matching location');
    expect(reasonFor(loc('teaching_location.moonstone', 0.2))).toBe(
      'low confidence 0.2',
    );
  });

  it('ignores answers to values that were not asked and duplicate answers', () => {
    const result = validateLlmResult(
      {
        certifications: [
          item('CSIA L4', {
            ...PARTIAL,
            isPartial: false,
            partialComponents: [],
          }),
          item('Td', null),
          item('Td', PARTIAL),
          'junk',
        ],
        locations: [
          {
            value: 'MSL',
            key: 'teaching_location.moonstone',
            confidence: 1,
            reason: 'r',
          },
          {
            value: 7,
            key: 'teaching_location.moonstone',
            confidence: 1,
            reason: 'r',
          },
        ],
      },
      REQUEST,
    );
    expect(result.certifications).toEqual([]);
    expect(result.locations).toEqual([]);
    expect(result.rejected).toEqual([
      { value: 'Td', reason: 'no certification' },
      { value: REQUEST.unresolvedCertifications[0], reason: 'not answered' },
      { value: 'Ottawa Region', reason: 'not answered' },
    ]);
  });

  it.each([null, 'text', [1], 42])('rejects everything for %j', (output) => {
    expect(validateLlmResult(output, REQUEST)).toEqual({
      certifications: [],
      trainerStatus: [],
      locations: [],
      rejected: [
        ...REQUEST.unresolvedCertifications,
        ...REQUEST.unresolvedLocations,
      ].map((value) => ({ value, reason: 'response is not a JSON object' })),
    });
  });

  it('treats missing arrays as unanswered', () => {
    expect(validateLlmResult({}, REQUEST).rejected).toHaveLength(3);
  });
});

describe('buildNormalizationInstruction', () => {
  it('lists the vocabulary and the allowed keys', () => {
    const text = buildNormalizationInstruction();
    expect(text).toContain('["ski","teach"]');
    expect(text).toContain('["instructor_training","riding","teaching"]');
    expect(text).toContain('"teaching_location.moonstone"');
    expect(text).toContain('"teaching_location.glen_eden"');
  });
});

type Init = { method: string; headers: Record<string, string>; body: string };

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

function fakeFetch(
  responses: { ok: boolean; status: number; body: unknown }[],
) {
  return jest.fn<Promise<FakeResponse>, [string, Init]>(() => {
    const next = responses.shift() as {
      ok: boolean;
      status: number;
      body: unknown;
    };
    return Promise.resolve({
      ok: next.ok,
      status: next.status,
      json: () =>
        next.body instanceof Error
          ? Promise.reject(next.body)
          : Promise.resolve(next.body),
    });
  });
}

function geminiText(text: string) {
  return {
    candidates: [
      { content: { parts: [{ text: 'thinking', thought: true }, { text }] } },
    ],
  };
}

describe('GeminiRosterNormalizer', () => {
  it("sends only the row's certification and location strings (PII guard)", async () => {
    const [entry] = parseRosterCsv(
      rosterCsv([
        {
          preferred: 'Quinn',
          legal: 'Quinn Zebulon Testperson',
          email: 'quinn.private@example.test',
          dob: '4/5/1991',
          certs: 'CSIA L3 Partial (Please specify in "Other"), Td',
          details: 'CSIA L3 2025',
          locations: 'MSL, Ottawa Region',
        },
      ]),
      new Date('2026-10-11T00:00:00Z'),
    ).entries;
    const request = buildLlmRequest(
      entry.raw,
      entry.unmappedCertifications,
      entry.unmappedLocations,
    );
    const fetch = fakeFetch([
      {
        ok: true,
        status: 200,
        body: geminiText('{"certifications":[],"locations":[]}'),
      },
    ]);
    const llm = new GeminiRosterNormalizer({ apiKey: 'key-1', fetch });
    await expect(llm.normalize(request)).resolves.toEqual({
      certifications: [],
      locations: [],
    });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    );
    expect(init.headers['x-goog-api-key']).toBe('key-1');
    const body = JSON.parse(init.body) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
      generationConfig: unknown;
    };
    expect(Object.keys(body).sort()).toEqual([
      'contents',
      'generationConfig',
      'systemInstruction',
    ]);
    expect(body.systemInstruction.parts[0].text).toBe(
      buildNormalizationInstruction(),
    );
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].parts).toHaveLength(1);
    expect(JSON.parse(body.contents[0].parts[0].text)).toEqual({
      certifications: 'CSIA L3 Partial (Please specify in "Other"), Td',
      certificationDetails: 'CSIA L3 2025',
      locations: 'MSL, Ottawa Region',
      unresolvedCertifications: ['CSIA L3 Partial (Please specify in "Other")'],
      unresolvedLocations: ['Ottawa Region'],
    });
    for (const secret of [
      'Quinn',
      'Testperson',
      'quinn.private',
      'example.test',
      '1991',
      '555-0100',
      'Fake Street',
      '000000000',
      'wx-fake',
      '9/1/2026',
      '"line"',
    ]) {
      expect(init.body).not.toContain(secret);
    }
  });

  it('honours GEMINI_MODEL, strips code fences and reports bad responses', async () => {
    const fetch = fakeFetch([
      { ok: true, status: 200, body: geminiText('```json\n{"a":1}\n```') },
      { ok: true, status: 200, body: geminiText('not json') },
      { ok: true, status: 200, body: {} },
      { ok: false, status: 503, body: { error: { message: 'overloaded' } } },
      { ok: false, status: 500, body: new Error('no body') },
    ]);
    const llm = new GeminiRosterNormalizer({
      apiKey: 'k',
      model: ' gemini-test ',
      fetch,
      baseUrl: 'https://llm.test',
    });
    expect(llm.modelId).toBe('gemini-test');
    await expect(llm.normalize(REQUEST)).resolves.toEqual({ a: 1 });
    await expect(llm.normalize(REQUEST)).rejects.toThrow(
      'Gemini returned no JSON',
    );
    await expect(llm.normalize(REQUEST)).rejects.toThrow(RosterLlmError);
    await expect(llm.normalize(REQUEST)).rejects.toThrow(
      'Gemini HTTP 503: overloaded',
    );
    await expect(llm.normalize(REQUEST)).rejects.toThrow(/^Gemini HTTP 500$/);
    expect(fetch.mock.calls[0][0]).toBe(
      'https://llm.test/models/gemini-test:generateContent',
    );
  });

  it('times out', async () => {
    const fetch = jest.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const llm = new GeminiRosterNormalizer({
      apiKey: 'k',
      fetch,
      timeoutMs: 5,
    });
    await expect(llm.normalize(REQUEST)).rejects.toThrow(
      'Gemini timed out after 5ms',
    );
  });

  it('defaults to the global fetch', () => {
    expect(new GeminiRosterNormalizer({ apiKey: 'k' }).modelId).toBe(
      DEFAULT_GEMINI_MODEL,
    );
  });
});
