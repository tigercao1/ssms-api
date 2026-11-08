import { crc32, inflateSync } from 'node:zlib';
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
const MAX_PALETTE_ENTRIES = 256;
const BIT_DEPTHS_BY_COLOUR_TYPE: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8],
  2: [8],
  3: [1, 2, 4, 8],
  4: [8],
  6: [8],
};
const CHANNELS_BY_COLOUR_TYPE: Record<number, number> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};
const ALLOWED_CHUNK_TYPES = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const MAX_FILTER_TYPE = 4;

export interface FormAnswers {
  signerName: string;
  signerEmail: string;
  values: Record<string, string>;
  signatures: Record<string, Uint8Array>;
}

const name = (field: FormField) => `${field.label} (${field.key})`;

interface PngChunk {
  type: string;
  data: Buffer;
}

function readPngChunks(png: Buffer): PngChunk[] | null {
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE_LENGTH;
  while (offset < png.length) {
    if (png.length - offset < 12) {
      return null;
    }
    const end = offset + 12 + png.readUInt32BE(offset);
    if (end > png.length) {
      return null;
    }
    const typeAndData = png.subarray(offset + 4, end - 4);
    if (crc32(typeAndData) !== png.readUInt32BE(end - 4)) {
      return null;
    }
    chunks.push({
      type: typeAndData.toString('latin1', 0, 4),
      data: typeAndData.subarray(4),
    });
    offset = end;
  }
  return chunks;
}

function inflateExactly(compressed: Buffer, length: number): Buffer | null {
  try {
    const inflated = inflateSync(compressed, { maxOutputLength: length });
    return inflated.length === length ? inflated : null;
  } catch {
    return null;
  }
}

function readSignaturePng(label: string, raw: unknown): Uint8Array {
  const png = Buffer.from(decodeSignaturePng(label, raw));
  const notPng = () => new SigningInputError(`Signature ${label} is not a PNG`);
  const unsupported = () =>
    new SigningInputError(
      `Signature ${label} must be an 8-bit, non-interlaced, single-frame PNG without metadata`,
    );
  const chunks = readPngChunks(png);
  if (
    !chunks ||
    chunks.length < 3 ||
    chunks[0].type !== 'IHDR' ||
    chunks[0].data.length !== IHDR_LENGTH ||
    chunks[chunks.length - 1].type !== 'IEND' ||
    chunks[chunks.length - 1].data.length !== 0
  ) {
    throw notPng();
  }
  if (chunks.some(({ type }) => !ALLOWED_CHUNK_TYPES.has(type))) {
    throw unsupported();
  }
  const types = chunks.map(({ type }) => type);
  const firstIdat = types.indexOf('IDAT');
  const idats = chunks.filter(({ type }) => type === 'IDAT');
  const palettes = chunks.filter(({ type }) => type === 'PLTE');
  if (
    types.lastIndexOf('IHDR') !== 0 ||
    types.indexOf('IEND') !== types.length - 1 ||
    firstIdat === -1 ||
    types.lastIndexOf('IDAT') !== firstIdat + idats.length - 1 ||
    palettes.length > 1 ||
    types.indexOf('PLTE') > firstIdat
  ) {
    throw notPng();
  }
  const header = chunks[0].data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [bitDepth, colourType, compression, filter, interlace] =
    header.subarray(8, 13);
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
  const palette = palettes[0]?.data;
  if (
    (colourType === 3 && !palette) ||
    ((colourType === 0 || colourType === 4) && palette) ||
    (palette &&
      (palette.length === 0 ||
        palette.length % 3 !== 0 ||
        palette.length / 3 > MAX_PALETTE_ENTRIES))
  ) {
    throw notPng();
  }
  const rowLength =
    1 + Math.ceil((width * CHANNELS_BY_COLOUR_TYPE[colourType] * bitDepth) / 8);
  const pixels = inflateExactly(
    Buffer.concat(idats.map(({ data }) => data)),
    rowLength * height,
  );
  if (!pixels) {
    throw notPng();
  }
  for (let row = 0; row < pixels.length; row += rowLength) {
    if (pixels[row] > MAX_FILTER_TYPE) {
      throw notPng();
    }
  }
  return png;
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
