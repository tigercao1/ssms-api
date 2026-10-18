import type {
  BioDraft,
  BioDraftInput,
  BioTranslationInput,
  BioTranslator,
} from './bio-translator.interface';
import {
  buildDraftInstruction,
  buildTranslationInstruction,
  parseSourceLangs,
} from './gemini-bio-translator';
import {
  OpenRouterClient,
  OpenRouterError,
  type Routing,
} from '../llm/openrouter.client';

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    en: { type: 'string' },
    zh: { type: 'string' },
    sourceLangs: {
      type: 'array',
      items: { type: 'string', enum: ['en', 'zh-CN'] },
    },
  },
  required: ['en', 'zh', 'sourceLangs'],
  additionalProperties: false,
};

export class OpenRouterBioTranslator implements BioTranslator {
  lastModelUsed: string | null = null;

  constructor(
    private readonly client: OpenRouterClient,
    private readonly routing: Routing,
    readonly modelId: string = routing.model,
  ) {}

  async translate(input: BioTranslationInput): Promise<string> {
    const result = await this.client.chat({
      routing: this.routing,
      timeoutMs: input.timeoutMs,
      messages: [
        {
          role: 'system',
          content: buildTranslationInstruction(
            input.from,
            input.to,
            input.kind,
          ),
        },
        { role: 'user', content: input.text },
      ],
    });
    this.lastModelUsed = result.model;
    return result.text;
  }

  async draft(input: BioDraftInput): Promise<BioDraft> {
    const result = await this.client.chat({
      routing: this.routing,
      jsonSchema: { name: 'bio_draft', schema: DRAFT_SCHEMA },
      messages: [
        {
          role: 'system',
          content: buildDraftInstruction(input.mode, input.maxLength),
        },
        { role: 'user', content: input.text },
      ],
    });
    this.lastModelUsed = result.model;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.text) as Record<string, unknown>;
    } catch {
      throw new OpenRouterError('OpenRouter returned invalid JSON', false);
    }
    const en = typeof parsed.en === 'string' ? parsed.en.trim() : '';
    const zh = typeof parsed.zh === 'string' ? parsed.zh.trim() : '';
    if (en === '' || zh === '') {
      throw new OpenRouterError('Draft is missing a language', false);
    }
    if (en.length > input.maxLength || zh.length > input.maxLength) {
      throw new OpenRouterError(
        `Draft exceeds ${input.maxLength} characters`,
        false,
      );
    }
    return { en, zh, sourceLangs: parseSourceLangs(parsed.sourceLangs) };
  }
}
