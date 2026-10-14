import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_BASE_URL,
  GEMINI_API_KEY_HEADER,
  type FetchLike,
} from '../../bio-translation/gemini-bio-translator';
import type { RosterRawValues } from './roster-csv';
import {
  ALLOWED_LOCATION_KEYS,
  PARTIAL_COMPONENTS,
  trainerDisciplineFor,
  validateCertification,
  validateTrainerStatus,
  type RosterCertification,
  type RosterTrainerStatus,
} from './roster-normalize';

export const LLM_MIN_CONFIDENCE = 0.8;
const REASON_MAX = 200;

/** Exactly what leaves the machine for one row: its raw certification and location strings. */
export interface RosterLlmRequest {
  certifications: string;
  certificationDetails: string;
  locations: string;
  unresolvedCertifications: string[];
  unresolvedLocations: string[];
}

/** Opt-in second pass for values the deterministic rules left unresolved. */
export interface RosterLlmNormalizer {
  readonly modelId: string;
  normalize(request: RosterLlmRequest): Promise<unknown>;
}

export interface LlmCertification {
  value: string;
  certification: RosterCertification;
}

export interface LlmTrainerStatus {
  value: string;
  trainerStatus: RosterTrainerStatus;
}

export interface LlmLocation {
  value: string;
  key: string;
}

export interface LlmValidationResult {
  certifications: LlmCertification[];
  trainerStatus: LlmTrainerStatus[];
  locations: LlmLocation[];
  rejected: { value: string; reason: string }[];
}

export function buildLlmRequest(
  raw: RosterRawValues,
  unresolvedCertifications: string[],
  unresolvedLocations: string[],
): RosterLlmRequest {
  return {
    certifications: raw.certifications,
    certificationDetails: raw.certificationDetails,
    locations: raw.locations,
    unresolvedCertifications: [...unresolvedCertifications],
    unresolvedLocations: [...unresolvedLocations],
  };
}

export function buildNormalizationInstruction(
  allowedLocationKeys: readonly string[] = ALLOWED_LOCATION_KEYS,
): string {
  return [
    'You normalise answers from a ski/snowboard instructor sign-up form for a school in Ontario, Canada.',
    'The user message is JSON with: "certifications" (the multi-select answer, comma-joined, may include free-text "Other" fragments), "certificationDetails" (free text: when and where the highest certification was received), "locations" (comma-joined preferred teaching locations), and the lists "unresolvedCertifications" and "unresolvedLocations".',
    'Interpret ONLY the values in "unresolvedCertifications" and "unresolvedLocations"; use the other fields as context.',
    'Certification rules:',
    '- org is "csia" (ski) or "casi" (snowboard).',
    '- track is "regular" (levels 1-4), "park" (levels 1-2, never partial) or "carving" (CASI only, level 1 only, never partial). Carving with no stated level is level 1.',
    `- A partial regular certification has isPartial true and at least one partialComponents entry from: csia ${JSON.stringify(PARTIAL_COMPONENTS.csia)}, casi ${JSON.stringify(PARTIAL_COMPONENTS.casi)}. Pedagogy/teaching is "teach" for CSIA and "teaching" for CASI; skiing is "ski" (CSIA); riding is "riding" (CASI).`,
    '- A full certification has isPartial false and partialComponents [].',
    '- A fragment that only names a component (for example "Teaching") describes the partial certification named elsewhere in the same answer; return that partial certification with the component.',
    '- "TD" or "Trainer Development" means the person passed the trainer exam (trainer development): return certification null and trainer {"discipline":"ski|snowboard","rookieSessionCompleted":true,"trainerExamPassed":true,"trainerLevel":1}. The discipline is "ski" for CSIA and "snowboard" for CASI, from the org named in the value itself, else the only org named in "certifications". If neither settles it, return trainer null.',
    '- If a value does not clearly describe one certification or trainer development, return certification null and trainer null.',
    `Location rules: key must be one of ${JSON.stringify(allowedLocationKeys)} or null. Return null for any place that is not one of these resorts.`,
    'Respond with JSON only, no markdown, exactly in this shape:',
    '{"certifications":[{"value":"<an unresolvedCertifications entry>","certification":{"org":"csia|casi","track":"regular|park|carving","level":1,"isPartial":false,"partialComponents":[]} or null,"trainer":{"discipline":"ski|snowboard","rookieSessionCompleted":true,"trainerExamPassed":true,"trainerLevel":1} or null,"confidence":0.0,"reason":"<under 20 words>"}],"locations":[{"value":"<an unresolvedLocations entry>","key":"<allowed key>" or null,"confidence":0.0,"reason":"<under 20 words>"}]}',
    'confidence is a number from 0 to 1 for how sure you are of that one interpretation.',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function itemProblem(item: Record<string, unknown>): string | null {
  const { confidence, reason } = item;
  if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) {
    return 'invalid confidence';
  }
  if (typeof reason !== 'string' || reason.length > REASON_MAX) {
    return 'invalid reason';
  }
  return confidence < LLM_MIN_CONFIDENCE
    ? `low confidence ${confidence}`
    : null;
}

/**
 * Accepts only items that answer one of the requested values, clear the
 * confidence bar and satisfy the migration 010 certification constraints, the
 * trainer-development rule of {@link validateTrainerStatus}, or name an
 * allowed location key. Everything else stays unresolved.
 */
export function validateLlmResult(
  output: unknown,
  request: RosterLlmRequest,
  allowedLocationKeys: readonly string[] = ALLOWED_LOCATION_KEYS,
): LlmValidationResult {
  const result: LlmValidationResult = {
    certifications: [],
    trainerStatus: [],
    locations: [],
    rejected: [],
  };
  if (!isRecord(output)) {
    result.rejected.push(
      ...[
        ...request.unresolvedCertifications,
        ...request.unresolvedLocations,
      ].map((value) => ({ value, reason: 'response is not a JSON object' })),
    );
    return result;
  }
  const seen = new Set<string>();
  const items = (field: string) =>
    (Array.isArray(output[field]) ? (output[field] as unknown[]) : []).filter(
      isRecord,
    );
  for (const item of items('certifications')) {
    const value = item.value;
    if (
      typeof value !== 'string' ||
      !request.unresolvedCertifications.includes(value) ||
      seen.has(`c:${value}`)
    ) {
      continue;
    }
    seen.add(`c:${value}`);
    const problem = itemProblem(item);
    const hasTrainer = item.trainer !== undefined && item.trainer !== null;
    const cert =
      item.certification === null
        ? null
        : validateCertification(item.certification);
    const trainer = hasTrainer
      ? validateTrainerStatus(
          item.trainer,
          trainerDisciplineFor(value, request.certifications),
        )
      : null;
    if (problem) {
      result.rejected.push({ value, reason: problem });
    } else if (item.certification === null && !hasTrainer) {
      result.rejected.push({ value, reason: 'no certification' });
    } else if (item.certification !== null && !cert) {
      result.rejected.push({ value, reason: 'violates certification rules' });
    } else if (hasTrainer && !trainer) {
      result.rejected.push({ value, reason: 'violates trainer rules' });
    } else {
      if (cert) {
        result.certifications.push({ value, certification: cert });
      }
      if (trainer) {
        result.trainerStatus.push({ value, trainerStatus: trainer });
      }
    }
  }
  for (const item of items('locations')) {
    const value = item.value;
    if (
      typeof value !== 'string' ||
      !request.unresolvedLocations.includes(value) ||
      seen.has(`l:${value}`)
    ) {
      continue;
    }
    seen.add(`l:${value}`);
    const problem = itemProblem(item);
    if (problem) {
      result.rejected.push({ value, reason: problem });
    } else if (item.key === null) {
      result.rejected.push({ value, reason: 'no matching location' });
    } else if (
      typeof item.key !== 'string' ||
      !allowedLocationKeys.includes(item.key)
    ) {
      result.rejected.push({ value, reason: 'location key not allowed' });
    } else {
      result.locations.push({ value, key: item.key });
    }
  }
  for (const value of request.unresolvedCertifications) {
    if (!seen.has(`c:${value}`)) {
      result.rejected.push({ value, reason: 'not answered' });
    }
  }
  for (const value of request.unresolvedLocations) {
    if (!seen.has(`l:${value}`)) {
      result.rejected.push({ value, reason: 'not answered' });
    }
  }
  return result;
}

export class RosterLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterLlmError';
  }
}

export interface GeminiRosterNormalizerOptions {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
  }[];
  error?: { message?: string };
}

/** Gemini `generateContent` with JSON output; the request body carries only {@link RosterLlmRequest}. */
export class GeminiRosterNormalizer implements RosterLlmNormalizer {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: GeminiRosterNormalizerOptions) {
    this.apiKey = options.apiKey;
    this.modelId = options.model?.trim() || DEFAULT_GEMINI_MODEL;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.baseUrl = options.baseUrl ?? GEMINI_API_BASE_URL;
  }

  async normalize(request: RosterLlmRequest): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
              parts: [{ text: buildNormalizationInstruction() }],
            },
            contents: [
              { role: 'user', parts: [{ text: JSON.stringify(request) }] },
            ],
            generationConfig: {
              temperature: 0,
              responseMimeType: 'application/json',
            },
          }),
          signal: controller.signal,
        },
      );
      const body = (await response.json().catch(() => ({}))) as GeminiResponse;
      if (!response.ok) {
        throw new RosterLlmError(
          `Gemini HTTP ${response.status}${body.error?.message ? `: ${body.error.message.slice(0, 200)}` : ''}`,
        );
      }
      const text = (body.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
        .trim()
        .replace(/^```(?:json)?\s*|\s*```$/g, '');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new RosterLlmError('Gemini returned no JSON');
      }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new RosterLlmError(`Gemini timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
