import { isEmail } from 'class-validator';
import {
  type FormField,
  SIGNER_EMAIL_KEY,
  SIGNER_NAME_KEY,
} from './form-templates.types';
import {
  decodeSignaturePng,
  isValidDate,
  MAX_FIELD_VALUE_LENGTH,
  SigningInputError,
} from './signing-input';

export const MAX_FORM_SIGNATURE_WIDTH = 1200;
export const MAX_FORM_SIGNATURE_HEIGHT = 600;
export const MAX_FORM_SIGNATURE_PIXELS = 1000 * 600;

const PNG_SIGNATURE_LENGTH = 8;
const IHDR_LENGTH = 13;
const BIT_DEPTHS_BY_COLOUR_TYPE: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8],
  2: [8],
  3: [1, 2, 4, 8],
  4: [8],
  6: [8],
};

/** Checked form answers: trimmed text by key, signature PNGs by key, and who signed. */
export interface FormAnswers {
  signerName: string;
  signerEmail: string;
  values: Record<string, string>;
  signatures: Record<string, Uint8Array>;
}

const name = (field: FormField) => `${field.label} (${field.key})`;

function readSignaturePng(label: string, raw: unknown): Uint8Array {
  const png = Buffer.from(decodeSignaturePng(label, raw));
  const notPng = () => new SigningInputError(`Signature ${label} is not a PNG`);
  const unsupported = () =>
    new SigningInputError(
      `Signature ${label} must be an 8-bit, non-interlaced, single-frame PNG`,
    );
  if (
    png.length < PNG_SIGNATURE_LENGTH + 8 + IHDR_LENGTH ||
    png.readUInt32BE(PNG_SIGNATURE_LENGTH) !== IHDR_LENGTH ||
    png.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw notPng();
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const [bitDepth, colourType, compression, filter, interlace] = png.subarray(
    24,
    29,
  );
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_FORM_SIGNATURE_WIDTH ||
    height > MAX_FORM_SIGNATURE_HEIGHT ||
    width * height > MAX_FORM_SIGNATURE_PIXELS
  ) {
    throw new SigningInputError(
      `Signature ${label} is too large: at most ${MAX_FORM_SIGNATURE_WIDTH} pixels wide, ${MAX_FORM_SIGNATURE_HEIGHT} high and ${MAX_FORM_SIGNATURE_PIXELS} in total`,
    );
  }
  if (
    !BIT_DEPTHS_BY_COLOUR_TYPE[colourType]?.includes(bitDepth) ||
    compression !== 0 ||
    filter !== 0 ||
    interlace !== 0
  ) {
    throw unsupported();
  }
  let offset = PNG_SIGNATURE_LENGTH;
  while (offset + 8 <= png.length) {
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') {
      throw unsupported();
    }
    if (type === 'IDAT') {
      return png;
    }
    offset += 12 + png.readUInt32BE(offset);
  }
  throw notPng();
}

function parseValue(field: FormField, raw: unknown): string {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new SigningInputError(`Field ${name(field)} must be text`);
  }
  const value = raw?.trim() ?? '';
  if ([...value].length > MAX_FIELD_VALUE_LENGTH) {
    throw new SigningInputError(
      `Field ${name(field)} is longer than ${MAX_FIELD_VALUE_LENGTH} characters`,
    );
  }
  if (value === '') {
    return value;
  }
  if (field.type === 'email' && !isEmail(value)) {
    throw new SigningInputError(`Field ${name(field)} must be an email`);
  }
  if (field.type === 'date' && !isValidDate(value)) {
    throw new SigningInputError(
      `Field ${name(field)} must be a date (YYYY-MM-DD)`,
    );
  }
  return field.type === 'email' ? value.toLowerCase() : value;
}

/**
 * Checks answers and signatures against a form version's fields: no unknown
 * keys, every required field present, emails and dates well formed, and
 * signature PNGs within the size and pixel caps. Throws {@link SigningInputError}.
 */
export function parseFormAnswers(
  fields: readonly FormField[],
  answers: Record<string, unknown>,
  signatures: Record<string, unknown>,
): FormAnswers {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const strayAnswer = Object.keys(answers).find(
    (key) => byKey.get(key)?.type === 'signature' || !byKey.has(key),
  );
  if (strayAnswer !== undefined) {
    throw new SigningInputError(`Unknown answer ${strayAnswer}`);
  }
  const straySignature = Object.keys(signatures).find(
    (key) => byKey.get(key)?.type !== 'signature',
  );
  if (straySignature !== undefined) {
    throw new SigningInputError(`Unknown signature ${straySignature}`);
  }
  const parsed: FormAnswers = {
    signerName: '',
    signerEmail: '',
    values: {},
    signatures: {},
  };
  for (const field of fields) {
    if (field.type === 'signature') {
      const raw = signatures[field.key];
      if (raw !== undefined && raw !== null && raw !== '') {
        parsed.signatures[field.key] = readSignaturePng(name(field), raw);
      } else if (field.required) {
        throw new SigningInputError(`Signature ${name(field)} is required`);
      }
      continue;
    }
    const value = parseValue(field, answers[field.key]);
    if (value === '' && field.required) {
      throw new SigningInputError(`Field ${name(field)} is required`);
    }
    if (value !== '') {
      parsed.values[field.key] = value;
    }
  }
  parsed.signerName = parsed.values[SIGNER_NAME_KEY] ?? '';
  parsed.signerEmail = parsed.values[SIGNER_EMAIL_KEY] ?? '';
  if (parsed.signerName === '' || parsed.signerEmail === '') {
    throw new SigningInputError(
      'The participant name and email are required to sign',
    );
  }
  return parsed;
}
