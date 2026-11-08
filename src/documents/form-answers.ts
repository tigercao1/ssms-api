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

/** Checked form answers: trimmed text by key, signature PNGs by key, and who signed. */
export interface FormAnswers {
  signerName: string;
  signerEmail: string;
  values: Record<string, string>;
  signatures: Record<string, Uint8Array>;
}

const name = (field: FormField) => `${field.label} (${field.key})`;

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
 * signature PNGs within the size cap. Throws {@link SigningInputError}.
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
        parsed.signatures[field.key] = decodeSignaturePng(name(field), raw);
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
