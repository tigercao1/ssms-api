import {
  FIELD_PREFILLS,
  FIELD_TYPES,
  type FieldType,
  type PageGeometry,
  type TemplateField,
} from './documents.types';

const EDGE_TOLERANCE = 0.01;

/** Field types filled with a picture or a checkmark, where a text prefill means nothing. */
const NON_TEXT_TYPES = new Set<FieldType>([
  'signature',
  'initials',
  'checkbox',
]);

/** A field list the template cannot accept, with a message fit for the admin. */
export class TemplateFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateFieldError';
  }
}

/** Whether a field's rect lies inside its page's visible box. */
export function insidePageBox(
  field: Pick<TemplateField, 'x' | 'y' | 'w' | 'h'>,
  page: PageGeometry,
): boolean {
  return (
    field.w > 0 &&
    field.h > 0 &&
    field.x >= page.x - EDGE_TOLERANCE &&
    field.y >= page.y - EDGE_TOLERANCE &&
    field.x + field.w <= page.x + page.width + EDGE_TOLERANCE &&
    field.y + field.h <= page.y + page.height + EDGE_TOLERANCE
  );
}

/**
 * Checks placed fields against the template's pages: unique ids, a known
 * type, an English label, a prefill that suits the type, an existing page,
 * and a rect inside that page's visible box. Throws {@link TemplateFieldError}.
 */
export function validateTemplateFields(
  fields: readonly TemplateField[],
  pages: readonly PageGeometry[],
): void {
  if (new Set(fields.map((f) => f.id)).size !== fields.length) {
    throw new TemplateFieldError('Field ids must be unique');
  }
  for (const field of fields) {
    if (!(FIELD_TYPES as readonly string[]).includes(field.type)) {
      throw new TemplateFieldError(
        `Field ${field.id} has an unknown type ${String(field.type)}`,
      );
    }
    if (!field.labelEn?.trim()) {
      throw new TemplateFieldError(`Field ${field.id} needs an English label`);
    }
    if (
      field.prefill != null &&
      (NON_TEXT_TYPES.has(field.type) ||
        !(FIELD_PREFILLS as readonly string[]).includes(field.prefill))
    ) {
      throw new TemplateFieldError(
        `Field ${field.id} (${field.type}) cannot be prefilled with ${field.prefill}`,
      );
    }
    const page = pages[field.page - 1];
    if (!page) {
      throw new TemplateFieldError(
        `Field ${field.id} is on page ${field.page}, but the PDF has ${pages.length} page(s)`,
      );
    }
    if (!insidePageBox(field, page)) {
      throw new TemplateFieldError(
        `Field ${field.id} is outside page ${field.page}`,
      );
    }
  }
}
