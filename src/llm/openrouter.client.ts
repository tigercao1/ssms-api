export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_AUTO_MODEL = 'openrouter/auto';

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

export interface ChatMessage {
  role: 'system' | 'user';
  content: string | ContentPart[];
}

export interface JsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
}

export interface Routing {
  model: string;
  fallbacks?: string[];
  allowedModels?: string[];
  costTier?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface ChatRequest {
  routing: Routing;
  messages: ChatMessage[];
  jsonSchema?: JsonSchemaFormat;
  temperature?: number;
  pdfEngine?: 'native' | 'cloudflare-ai' | 'mistral-ocr';
  zeroDataRetention?: boolean;
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  model: string;
  generationId: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cost: number | null;
  };
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export interface OpenRouterClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  appTitle?: string;
  appUrl?: string;
  timeoutMs?: number;
}

interface CompletionResponse {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}

export function buildRequestBody(
  request: ChatRequest,
): Record<string, unknown> {
  const { routing } = request;
  const body: Record<string, unknown> = {
    messages: request.messages,
    temperature: request.temperature ?? 0,
    provider: {
      data_collection: 'deny',
      ...(request.zeroDataRetention ? { zdr: true } : {}),
      require_parameters: request.jsonSchema !== undefined,
    },
    usage: { include: true },
  };
  if (routing.fallbacks?.length) {
    body.models = [routing.model, ...routing.fallbacks];
  } else {
    body.model = routing.model;
  }
  const plugins: Record<string, unknown>[] = [];
  if (routing.model === OPENROUTER_AUTO_MODEL) {
    plugins.push({
      id: 'auto-router',
      ...(routing.allowedModels
        ? { allowed_models: routing.allowedModels }
        : {}),
      ...(routing.costTier ? { cost_tier: routing.costTier } : {}),
    });
  }
  if (request.pdfEngine) {
    plugins.push({ id: 'file-parser', pdf: { engine: request.pdfEngine } });
  }
  if (plugins.length) {
    body.plugins = plugins;
  }
  if (request.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: request.jsonSchema.name,
        strict: true,
        schema: request.jsonSchema.schema,
      },
    };
  }
  return body;
}

export class OpenRouterClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenRouterClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? OPENROUTER_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
            ...(this.options.appUrl
              ? { 'HTTP-Referer': this.options.appUrl }
              : {}),
            ...(this.options.appTitle
              ? { 'X-Title': this.options.appTitle }
              : {}),
          },
          body: JSON.stringify(buildRequestBody(request)),
          signal: controller.signal,
        },
      );
      const json = (await response
        .json()
        .catch(() => ({}))) as CompletionResponse;
      if (!response.ok || json.error) {
        const status = json.error?.code ?? response.status;
        throw new OpenRouterError(
          `OpenRouter HTTP ${status}${json.error?.message ? `: ${json.error.message.slice(0, 200)}` : ''}`,
          status === 408 || status === 429 || status >= 500,
        );
      }
      const text = (json.choices?.[0]?.message?.content ?? '').trim();
      if (text === '') {
        throw new OpenRouterError('OpenRouter returned no text', false);
      }
      return {
        text,
        model: json.model ?? request.routing.model,
        generationId: json.id ?? null,
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          cost: json.usage?.cost ?? null,
        },
      };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new OpenRouterError(
          `OpenRouter timed out after ${timeoutMs}ms`,
          true,
        );
      }
      if (err instanceof OpenRouterError) {
        throw err;
      }
      throw new OpenRouterError(
        `OpenRouter request failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
