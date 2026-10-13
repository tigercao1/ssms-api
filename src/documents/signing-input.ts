import type { TemplateFieldRow } from './documents.types';
import type { StampSignature } from './pdf-stamper';

export const MAX_SIGNATURE_PNG_BYTES = 200 * 1024;
export const MAX_TYPED_SIGNATURE_LENGTH = 100;
export const MAX_FIELD_VALUE_LENGTH = 500;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DATA_URL_PREFIX = /^data:image\/png;base64,/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SIGNATURE_TYPES = new Set<TemplateFieldRow['type']>([
  'signature',
  'initials',
]);

/** Signing input the template cannot accept, with a message fit for the signer. */
export class SigningInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningInputError';
  }
}

/** Raw `sign` body after DTO validation. */
export interface SigningBody {
  signerName?: string;
  values?: Record<string, unknown>;
  signatures?: Record<string, unknown>;
}

/** Values used when a field is left blank and has a prefill. */
export interface SigningPrefills {
  email: string;
  dateSigned: string;
}

/** Checked input ready for the stamper, plus the values to store on the assignment. */
export interface SigningInput {
  signerName: string;
  values: Record<string, string | boolean>;
  signatures: Record<string, StampSignature>;
  fieldValues: Record<string, string | boolean>;
}

function label(field: TemplateFieldRow): string {
  return `${field.label_en} (${field.id})`;
}

function isValidDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function decodePng(field: TemplateFieldRow, encoded: unknown): Uint8Array {
  if (typeof encoded !== 'string') {
    throw new SigningInputError(`Signature ${label(field)} needs a base64 PNG`);
  }
  const base64 = encoded.replace(DATA_URL_PREFIX, '').replace(/\s/g, '');
  if (base64.length > Math.ceil(MAX_SIGNATURE_PNG_BYTES / 3) * 4 + 4) {
    throw new SigningInputError(
      `Signature ${label(field)} is larger than ${MAX_SIGNATURE_PNG_BYTES / 1024} KB`,
    );
  }
  if (!BASE64.test(base64)) {
    throw new SigningInputError(
      `Signature ${label(field)} is not valid base64`,
    );
  }
  const png = Buffer.from(base64, 'base64');
  if (png.length > MAX_SIGNATURE_PNG_BYTES) {
    throw new SigningInputError(
      `Signature ${label(field)} is larger than ${MAX_SIGNATURE_PNG_BYTES / 1024} KB`,
    );
  }
  if (!png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new SigningInputError(`Signature ${label(field)} is not a PNG`);
  }
  return png;
}

function parseSignature(
  field: TemplateFieldRow,
  raw: unknown,
): StampSignature | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const { mode, png, text } = (typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  if (mode === 'drawn') {
    return { mode, png: decodePng(field, png) };
  }
  if (mode === 'typed' && typeof text === 'string') {
    const trimmed = text.trim();
    if (trimmed === '') {
      return null;
    }
    if ([...trimmed].length > MAX_TYPED_SIGNATURE_LENGTH) {
      throw new SigningInputError(
        `Signature ${label(field)} is longer than ${MAX_TYPED_SIGNATURE_LENGTH} characters`,
      );
    }
    return { mode, text: trimmed };
  }
  throw new SigningInputError(
    `Signature ${label(field)} must be { mode: 'drawn', png } or { mode: 'typed', text }`,
  );
}

function prefillFor(
  field: TemplateFieldRow,
  signerName: string,
  prefills: SigningPrefills,
): string {
  switch (field.prefill) {
    case 'full_name':
      return signerName;
    case 'email':
      return prefills.email;
    case 'date_signed':
      return prefills.dateSigned;
    default:
      return field.type === 'full_name' ? signerName : '';
  }
}

function parseText(
  field: TemplateFieldRow,
  raw: unknown,
  signerName: string,
  prefills: SigningPrefills,
): string {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new SigningInputError(`Field ${label(field)} must be text`);
  }
  const value = raw?.trim() || prefillFor(field, signerName, prefills);
  if ([...value].length > MAX_FIELD_VALUE_LENGTH) {
    throw new SigningInputError(
      `Field ${label(field)} is longer than ${MAX_FIELD_VALUE_LENGTH} characters`,
    );
  }
  if (field.type === 'date' && value !== '' && !isValidDate(value)) {
    throw new SigningInputError(
      `Field ${label(field)} must be a date (YYYY-MM-DD)`,
    );
  }
  return value;
}

/**
 * Checks a `sign` body against the template's fields: a signer name, every
 * required field present, values of the right type, signature PNGs at most
 * {@link MAX_SIGNATURE_PNG_BYTES}, and no values for unknown fields. Blank
 * text fields take their prefill. Throws {@link SigningInputError}.
 */
export function parseSigningInput(
  fields: readonly TemplateFieldRow[],
  body: SigningBody,
  prefills: SigningPrefills,
): SigningInput {
  const signerName = body.signerName?.trim() ?? '';
  if (signerName === '') {
    throw new SigningInputError('Type your full legal name to sign');
  }
  const rawValues = body.values ?? {};
  const rawSignatures = body.signatures ?? {};
  const typeOf = new Map(fields.map((f) => [f.id, f.type]));
  const isSignatureField = (id: string) =>
    SIGNATURE_TYPES.has(typeOf.get(id) ?? 'text');
  const strayValue = Object.keys(rawValues).find(
    (id) => !typeOf.has(id) || isSignatureField(id),
  );
  if (strayValue !== undefined) {
    throw new SigningInputError(`Unknown value field ${strayValue}`);
  }
  const straySignature = Object.keys(rawSignatures).find(
    (id) => !isSignatureField(id),
  );
  if (straySignature !== undefined) {
    throw new SigningInputError(`Unknown signature field ${straySignature}`);
  }

  const input: SigningInput = {
    signerName,
    values: {},
    signatures: {},
    fieldValues: {},
  };
  for (const field of fields) {
    if (SIGNATURE_TYPES.has(field.type)) {
      const signature = parseSignature(field, rawSignatures[field.id]);
      if (signature) {
        input.signatures[field.id] = signature;
      } else if (field.required) {
        throw new SigningInputError(`Signature ${label(field)} is required`);
      }
      continue;
    }
    const raw = rawValues[field.id];
    if (field.type === 'checkbox') {
      if (raw !== undefined && raw !== null && typeof raw !== 'boolean') {
        throw new SigningInputError(
          `Field ${label(field)} must be true or false`,
        );
      }
      const checked = raw === true;
      if (field.required && !checked) {
        throw new SigningInputError(`Field ${label(field)} must be ticked`);
      }
      input.values[field.id] = checked;
      input.fieldValues[field.id] = checked;
      continue;
    }
    const value = parseText(field, raw, signerName, prefills);
    if (field.required && value === '') {
      throw new SigningInputError(`Field ${label(field)} is required`);
    }
    if (value !== '') {
      input.values[field.id] = value;
      input.fieldValues[field.id] = value;
    }
  }
  return input;
}
