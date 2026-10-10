import { Logger } from '@nestjs/common';
import type {
  BioLang,
  BioTranslationInput,
  BioTranslator,
  TranslationKind,
} from './bio-translator.interface';
import { PRESERVED_TERMS, TRANSLATION_GLOSSARY } from './translation-glossary';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
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

  private async request(
    input: BioTranslationInput,
    timeoutMs: number,
  ): Promise<string> {
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
          body: JSON.stringify({
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
          }),
          signal: controller.signal,
        },
      );
      const body = (await response.json().catch(() => ({}))) as GeminiResponse;
      if (!response.ok) {
        throw new GeminiTranslationError(
          `Gemini HTTP ${response.status}${body.error?.message ? `: ${body.error.message.slice(0, 200)}` : ''}`,
          response.status === 429 || response.status >= 500,
        );
      }
      const text = extractText(body);
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
