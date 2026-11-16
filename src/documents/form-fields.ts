import type {
  FormField,
  FormFieldType,
  FormVersionRow,
} from './form-templates.types';

const DRAWN_TYPES = new Set<FormFieldType>(['signature', 'initials']);

export function isDrawnField(field: Pick<FormField, 'type'>): boolean {
  return DRAWN_TYPES.has(field.type);
}

export function signerFields(fields: readonly FormField[]): {
  name: FormField | null;
  email: FormField | null;
} {
  const first = (type: FormFieldType) =>
    fields.find((f) => f.type === type && f.required) ?? null;
  return { name: first('full_name'), email: first('email') };
}

export function duplicateKeys(fields: readonly Pick<FormField, 'key'>[]) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { key } of fields) {
    if (seen.has(key)) repeated.add(key);
    seen.add(key);
  }
  return [...repeated];
}

export function publishProblems(version: FormVersionRow): string[] {
  const problems: string[] = [];
  if (!version.source_key && version.body_markdown.trim() === '') {
    problems.push('write the form text or upload a PDF');
  }
  const signer = signerFields(version.fields);
  if (!signer.name) {
    problems.push('add a required Full name field for the signer');
  }
  if (!signer.email) {
    problems.push('add a required Email field for the signer');
  }
  if (version.source_key) {
    const placed = new Set(version.placements.map((p) => p.key));
    const unplaced = version.fields
      .filter((f) => f.required && !placed.has(f.key))
      .map((f) => f.key);
    if (unplaced.length > 0) {
      problems.push(
        `place these required fields on the PDF: ${unplaced.join(', ')}`,
      );
    }
  }
  return problems;
}
