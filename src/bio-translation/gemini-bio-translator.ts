import { Logger } from '@nestjs/common';
import type {
  BioDraft,
  BioDraftInput,
  BioDraftMode,
  BioLang,
  BioTranslationInput,
  BioTranslator,
  TranslationKind,
} from './bio-translator.interface';
import { PRESERVED_TERMS, TRANSLATION_GLOSSARY } from './translation-glossary';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const GEMINI_API_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_API_KEY_HEADER = 'x-goog-api-key';

const LANGUAGE_NAMES: Record<BioLang, string> = {
  en: 'English',
  'zh-CN': 'Simplified Chinese',
};

const SUBJECTS: Record<TranslationKind, string> = {
  bio: "a ski/snowboard instructor's self-description",
  'reference-name':
    'a short label used by a ski/snowboard school (a ski resort or teaching location, a spoken language, a course level or an exam preparation)',
};

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GeminiBioTranslatorOptions {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  baseUrl?: string;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
  error?: { message?: string };
}

export class GeminiTranslationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GeminiTranslationError';
  }
}

export function buildTranslationInstruction(
  from: BioLang,
  to: BioLang,
  kind: TranslationKind = 'bio',
): string {
  const glossary = TRANSLATION_GLOSSARY.map(
    (entry) => `- ${entry.zh.join(' / ')} = ${entry.en}`,
  ).join('\n');
  return [
    `Translate ${SUBJECTS[kind]} from ${LANGUAGE_NAMES[from]} into ${LANGUAGE_NAMES[to]}.`,
    `Keep people's names, certifications (${PRESERVED_TERMS.join(', ')}), numbers and URLs unchanged.`,
    'Write naturally, as a native speaker would; do not translate word for word.',
    'Use this glossary in both directions:',
    glossary,
    'Output only the translation, with no quotes, notes or explanations.',
  ].join('\n');
}

const DRAFT_TASKS: Record<BioDraftMode, string[]> = {
  refine: [
    'Polish the wording in the language or languages it is written in: fix grammar, spelling and flow, keep every fact, the first person and the tone, and add nothing new.',
    'Then give the polished bio in both English and Simplified Chinese.',
  ],
  translate: [
    "Keep the instructor's wording exactly as written; do not polish, shorten or reorder it.",
    'Translate only what is missing: English parts stay unchanged in "en" and are translated into "zh"; Chinese parts stay unchanged in "zh" and are translated into "en".',
  ],
};

const DRAFT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    en: { type: 'STRING' },
    zh: { type: 'STRING' },
    sourceLangs: {
      type: 'ARRAY',
      items: { type: 'STRING', enum: ['en', 'zh-CN'] },
    },
  },
  required: ['en', 'zh', 'sourceLangs'],
  propertyOrdering: ['en', 'zh', 'sourceLangs'],
};

const BIO_LANGS: readonly BioLang[] = ['en', 'zh-CN'];

export function buildDraftInstruction(
  mode: BioDraftMode,
  maxLength: number,
): string {
  const glossary = TRANSLATION_GLOSSARY.map(
    (entry) => `- ${entry.zh.join(' / ')} = ${entry.en}`,
  ).join('\n');
  return [
    `The user message is ${SUBJECTS.bio}, written in English, Simplified Chinese or a mix of both.`,
    ...DRAFT_TASKS[mode],
    '"en" must be the complete bio in English and "zh" the complete bio in Simplified Chinese.',
    `Keep people's names, certifications (${PRESERVED_TERMS.join(', ')}), numbers and URLs unchanged.`,
    'Write naturally, as a native speaker would; do not translate word for word.',
    'Use this glossary in both directions:',
    glossary,
    `Each of "en" and "zh" must be at most ${maxLength} characters.`,
    '"sourceLangs" lists the languages the user message is written in: ["en"], ["zh-CN"] or ["en", "zh-CN"] for mixed text.',
    'Respond with JSON only: {"en": "...", "zh": "...", "sourceLangs": [...]}.',
  ].join('\n');
}

export class GeminiBioTranslator implements BioTranslator {
  private readonly logger = new Logger(GeminiBioTranslator.name);
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly baseUrl: string;

  constructor(options: GeminiBioTranslatorOptions) {
    this.apiKey = options.apiKey;
    this.modelId = options.model?.trim() || DEFAULT_GEMINI_MODEL;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.baseUrl = options.baseUrl ?? GEMINI_API_BASE_URL;
  }

  async translate(input: BioTranslationInput): Promise<string> {
    const deadline =
      input.timeoutMs === undefined ? undefined : Date.now() + input.timeoutMs;
    let lastError: GeminiTranslationError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const remaining =
        deadline === undefined ? this.timeoutMs : deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      try {
        return await this.request(input, Math.min(this.timeoutMs, remaining));
      } catch (err) {
        lastError = toTranslationError(err);
        if (!lastError.retryable || attempt === this.maxAttempts) {
          throw lastError;
        }
        this.logger.warn(
          `Gemini attempt ${attempt} failed (${lastError.message}); retrying`,
        );
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError ?? new GeminiTranslationError('Gemini timed out', true);
  }

  /** Single attempt: the caller is waiting and the quota counts the call. */
  async draft(input: BioDraftInput): Promise<BioDraft> {
    const text = await this.generate(
      {
        systemInstruction: {
          parts: [{ text: buildDraftInstruction(input.mode, input.maxLength) }],
        },
        contents: [{ role: 'user', parts: [{ text: input.text }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: DRAFT_RESPONSE_SCHEMA,
        },
      },
      this.timeoutMs,
    );
    return parseDraft(text, input.maxLength);
  }

  private request(
    input: BioTranslationInput,
    timeoutMs: number,
  ): Promise<string> {
    return this.generate(
      {
        systemInstruction: {
          parts: [
            {
              text: buildTranslationInstruction(
                input.from,
                input.to,
                input.kind,
              ),
            },
          ],
        },
        contents: [{ role: 'user', parts: [{ text: input.text }] }],
      },
      timeoutMs,
    );
  }

  private async generate(body: object, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/models/${encodeURIComponent(this.modelId)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [GEMINI_API_KEY_HEADER]: this.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const json = (await response.json().catch(() => ({}))) as GeminiResponse;
      if (!response.ok) {
        throw new GeminiTranslationError(
          `Gemini HTTP ${response.status}${json.error?.message ? `: ${json.error.message.slice(0, 200)}` : ''}`,
          response.status === 429 || response.status >= 500,
        );
      }
      const text = extractText(json);
      if (text === '') {
        throw new GeminiTranslationError('Gemini returned no text', false);
      }
      return text;
    } catch (err) {
      if (controller.signal.aborted) {
        throw new GeminiTranslationError(
          `Gemini timed out after ${timeoutMs}ms`,
          true,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseDraft(text: string, maxLength: number): BioDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiTranslationError('Gemini returned invalid JSON', false);
  }
  const { en, zh, sourceLangs } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof en !== 'string' || typeof zh !== 'string') {
    throw new GeminiTranslationError('Gemini draft is missing en or zh', false);
  }
  const draft = {
    en: en.trim(),
    zh: zh.trim(),
    sourceLangs: parseSourceLangs(sourceLangs),
  };
  if (draft.en === '' || draft.zh === '') {
    throw new GeminiTranslationError(
      'Gemini draft has an empty language',
      false,
    );
  }
  if (draft.en.length > maxLength || draft.zh.length > maxLength) {
    throw new GeminiTranslationError(
      `Gemini draft exceeds ${maxLength} characters`,
      false,
    );
  }
  return draft;
}

/** A non-empty subset of the bio languages, returned in canonical order. */
export function parseSourceLangs(value: unknown): BioLang[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((lang) => BIO_LANGS.includes(lang as BioLang))
  ) {
    throw new GeminiTranslationError(
      'Gemini draft has invalid sourceLangs',
      false,
    );
  }
  return BIO_LANGS.filter((lang) => value.includes(lang));
}

function extractText(body: GeminiResponse): string {
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
}

function toTranslationError(err: unknown): GeminiTranslationError {
  if (err instanceof GeminiTranslationError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new GeminiTranslationError(`Gemini request failed: ${message}`, true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
