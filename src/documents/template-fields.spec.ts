import type { PageGeometry, TemplateField } from './documents.types';
import {
  insidePageBox,
  TemplateFieldError,
  validateTemplateFields,
} from './template-fields';

const LETTER: PageGeometry = { width: 612, height: 792, rotate: 0, x: 0, y: 0 };
const CROPPED: PageGeometry = {
  width: 540,
  height: 700,
  rotate: 0,
  x: 36,
  y: 48,
};

const field = (overrides: Partial<TemplateField> = {}): TemplateField => ({
  id: 'f_1',
  type: 'text',
  page: 1,
  x: 72,
  y: 100,
  w: 200,
  h: 24,
  required: true,
  labelEn: 'Name',
  labelZh: null,
  prefill: null,
  ...overrides,
});

describe('insidePageBox', () => {
  it('accepts rects touching the edges and rejects rects past them', () => {
    expect(insidePageBox({ x: 0, y: 0, w: 612, h: 792 }, LETTER)).toBe(true);
    expect(insidePageBox({ x: 0.005, y: 0, w: 612, h: 792 }, LETTER)).toBe(
      true,
    );
    expect(insidePageBox({ x: -1, y: 0, w: 10, h: 10 }, LETTER)).toBe(false);
    expect(insidePageBox({ x: 0, y: 785, w: 10, h: 10 }, LETTER)).toBe(false);
    expect(insidePageBox({ x: 10, y: 10, w: 0, h: 10 }, LETTER)).toBe(false);
  });

  it('uses the offset visible box of a cropped page', () => {
    expect(insidePageBox({ x: 36, y: 48, w: 540, h: 700 }, CROPPED)).toBe(true);
    expect(insidePageBox({ x: 10, y: 100, w: 50, h: 20 }, CROPPED)).toBe(false);
    expect(insidePageBox({ x: 100, y: 40, w: 50, h: 20 }, CROPPED)).toBe(false);
    expect(insidePageBox({ x: 560, y: 100, w: 20, h: 20 }, CROPPED)).toBe(
      false,
    );
    expect(insidePageBox({ x: 100, y: 740, w: 20, h: 20 }, CROPPED)).toBe(
      false,
    );
  });
});

describe('validateTemplateFields', () => {
  const reject = (fields: TemplateField[], message: RegExp) =>
    expect(() => validateTemplateFields(fields, [LETTER, CROPPED])).toThrow(
      new RegExp(message.source),
    );

  it('accepts valid fields on every page', () => {
    expect(() =>
      validateTemplateFields(
        [
          field(),
          field({ id: 'f_2', page: 2, x: 40, y: 50, type: 'signature' }),
          field({ id: 'f_3', type: 'date', prefill: 'date_signed' }),
          field({ id: 'f_4', type: 'full_name', prefill: 'full_name' }),
        ],
        [LETTER, CROPPED],
      ),
    ).not.toThrow();
    expect(() => validateTemplateFields([], [])).not.toThrow();
  });

  it('rejects duplicate ids, unknown types, missing labels and bad prefills', () => {
    reject([field(), field()], /unique/);
    reject([field({ type: 'stamp' as never })], /unknown type stamp/);
    reject([field({ labelEn: '  ' })], /English label/);
    reject(
      [field({ type: 'signature', prefill: 'full_name' })],
      /cannot be prefilled/,
    );
    reject([field({ type: 'checkbox', prefill: 'email' })], /cannot be/);
    reject([field({ prefill: 'nickname' as never })], /cannot be prefilled/);
  });

  it('rejects missing pages and rects outside the page box', () => {
    reject([field({ page: 3 })], /page 3, but the PDF has 2/);
    reject([field({ page: 2, x: 10 })], /outside page 2/);
    reject([field({ x: 500, w: 200 })], /outside page 1/);
  });

  it('throws TemplateFieldError', () => {
    expect(() => validateTemplateFields([field(), field()], [LETTER])).toThrow(
      TemplateFieldError,
    );
  });
});
