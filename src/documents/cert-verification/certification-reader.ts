import {
  type ContentPart,
  OpenRouterClient,
  OpenRouterError,
  type Routing,
} from '../../llm/openrouter.client';
import type {
  CertificationExtraction,
  ExtractedCertification,
} from './certification-decision';
import {
  DOCUMENT_TYPES,
  EXTRACTION_SCHEMA,
  buildExtractionInstruction,
} from './certification-policy';

export interface CertificationFile {
  bytes: Buffer;
  contentType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface CertificationReading {
  extraction: CertificationExtraction;
  model: string;
  generationId: string | null;
  cost: number | null;
}

export class CertificationReader {
  constructor(
    private readonly client: OpenRouterClient,
    private readonly routing: Routing,
  ) {}

  async read(file: CertificationFile): Promise<CertificationReading> {
    const dataUrl = `data:${file.contentType};base64,${file.bytes.toString('base64')}`;
    const part: ContentPart =
      file.contentType === 'application/pdf'
        ? {
            type: 'file',
            file: { filename: 'certification.pdf', file_data: dataUrl },
          }
        : { type: 'image_url', image_url: { url: dataUrl } };
    const result = await this.client.chat({
      routing: this.routing,
      zeroDataRetention: true,
      pdfEngine: file.contentType === 'application/pdf' ? 'native' : undefined,
      jsonSchema: {
        name: 'certification_extraction',
        schema: EXTRACTION_SCHEMA,
      },
      timeoutMs: 60_000,
      messages: [
        { role: 'system', content: buildExtractionInstruction() },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract the fields from this document.' },
            part,
          ],
        },
      ],
    });
    return {
      extraction: parseExtraction(result.text),
      model: result.model,
      generationId: result.generationId,
      cost: result.usage.cost,
    };
  }
}

export function parseExtraction(text: string): CertificationExtraction {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<
      string,
      unknown
    >;
  } catch {
    throw new OpenRouterError(
      'Certification reader returned invalid JSON',
      false,
    );
  }
  const conf = (value.confidence ?? {}) as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === 'number' && v >= 0 && v <= 1 ? v : 0;
  const str = (v: unknown) =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  const documentType = DOCUMENT_TYPES.includes(value.documentType as never)
    ? (value.documentType as CertificationExtraction['documentType'])
    : 'other';
  const certifications = Array.isArray(value.certifications)
    ? (value.certifications as Record<string, unknown>[]).map((c) => ({
        text: typeof c.text === 'string' ? c.text.slice(0, 200) : '',
        track: ['regular', 'park', 'carving'].includes(c.track as string)
          ? (c.track as ExtractedCertification['track'])
          : null,
        level: Number.isInteger(c.level) ? (c.level as number) : null,
        isPartial: c.isPartial === true,
        confidence: num(c.confidence),
      }))
    : [];
  return {
    documentType,
    issuer: str(value.issuer),
    org: value.org === 'csia' || value.org === 'casi' ? value.org : null,
    holderName: str(value.holderName),
    memberNumber: str(value.memberNumber),
    membershipCategory: str(value.membershipCategory),
    membershipSeason: str(value.membershipSeason),
    certifications,
    validThrough: str(value.validThrough),
    recallYear: Number.isInteger(value.recallYear)
      ? (value.recallYear as number)
      : null,
    legible: value.legible === true,
    tamperSigns: Array.isArray(value.tamperSigns)
      ? value.tamperSigns.filter((s): s is string => typeof s === 'string')
      : [],
    confidence: {
      holderName: num(conf.holderName),
      org: num(conf.org),
      memberNumber: num(conf.memberNumber),
      validThrough: num(conf.validThrough),
    },
    notes: typeof value.notes === 'string' ? value.notes.slice(0, 500) : '',
  };
}
