import { signaturePng } from '../../test/helpers/png-fixtures';
import type { TemplateFieldRow } from './documents.types';
import {
  MAX_SIGNATURE_PNG_BYTES,
  parseSigningInput,
  type SigningBody,
  SigningInputError,
} from './signing-input';

const field = (
  id: string,
  type: TemplateFieldRow['type'],
  overrides: Partial<TemplateFieldRow> = {},
): TemplateFieldRow => ({
  id,
  type,
  page: 1,
  x: 10,
  y: 10,
  w: 100,
  h: 20,
  required: true,
  label_en: id,
  label_zh: null,
  prefill: null,
  ...overrides,
});

const FIELDS = [
  field('sig', 'signature'),
  field('ini', 'initials', { required: false }),
  field('name', 'full_name'),
  field('email', 'text', { prefill: 'email', required: false }),
  field('when', 'date', { prefill: 'date_signed' }),
  field('note', 'text', { required: false }),
  field('due', 'date', { required: false }),
  field('agree', 'checkbox'),
  field('optIn', 'checkbox', { required: false }),
];
const PREFILLS = { email: 'alice@example.com', dateSigned: '2026-10-12' };
const PNG = signaturePng(120, 40).toString('base64');

function parse(body: SigningBody, fields = FIELDS) {
  return parseSigningInput(fields, body, PREFILLS);
}

const valid: SigningBody = {
  signerName: '  Alice Wang ',
  values: { agree: true },
  signatures: { sig: { mode: 'drawn', png: PNG } },
};

describe('parseSigningInput', () => {
  it('fills blanks from prefills and keeps signatures out of stored values', () => {
    const input = parse(valid);
    expect(input.signerName).toBe('Alice Wang');
    expect(input.values).toEqual({
      name: 'Alice Wang',
      email: 'alice@example.com',
      when: '2026-10-12',
      agree: true,
      optIn: false,
    });
    expect(input.fieldValues).toEqual(input.values);
    expect(input.signatures.sig).toMatchObject({ mode: 'drawn' });
    expect(
      Buffer.from((input.signatures.sig as { png: Uint8Array }).png),
    ).toEqual(Buffer.from(PNG, 'base64'));
    expect(input.signatures).not.toHaveProperty('ini');
  });

  it('keeps sent values for plain fields, accepts data URLs and typed signatures', () => {
    const input = parse({
      ...valid,
      values: { agree: true, name: ' 王小明 ', due: '2026-01-31', note: 'hi' },
      signatures: {
        sig: { mode: 'drawn', png: `data:image/png;base64,${PNG}` },
        ini: { mode: 'typed', text: ' AW ' },
      },
    });
    expect(input.values).toMatchObject({
      name: '王小明',
      due: '2026-01-31',
      note: 'hi',
    });
    expect(input.signatures.ini).toEqual({ mode: 'typed', text: 'AW' });
  });

  it('stamps server values into prefilled fields and ignores client values for them', () => {
    const input = parse(
      {
        ...valid,
        values: {
          agree: true,
          when: '1999-01-01',
          email: 'spoof@example.com',
          sameName: 'Someone Else',
        },
      },
      [
        ...FIELDS,
        field('sameName', 'text', { prefill: 'full_name', required: false }),
      ],
    );
    expect(input.values).toMatchObject({
      when: '2026-10-12',
      email: 'alice@example.com',
      sameName: 'Alice Wang',
    });
  });

  it.each<[string, SigningBody, RegExp]>([
    ['no signer name', { ...valid, signerName: '  ' }, /full legal name/],
    [
      'missing signature',
      { ...valid, signatures: {} },
      /Signature sig \(sig\) is required/,
    ],
    [
      'blank typed signature',
      { ...valid, signatures: { sig: { mode: 'typed', text: ' ' } } },
      /is required/,
    ],
    ['unticked required checkbox', { ...valid, values: {} }, /must be ticked/],
    [
      'non-boolean checkbox',
      { ...valid, values: { agree: 'yes' } },
      /true or false/,
    ],
    [
      'non-string text',
      { ...valid, values: { agree: true, note: 5 } },
      /must be text/,
    ],
    [
      'bad date',
      { ...valid, values: { agree: true, due: '2026-02-30' } },
      /YYYY-MM-DD/,
    ],
    [
      'loose date',
      { ...valid, values: { agree: true, due: 'Oct 12' } },
      /YYYY-MM-DD/,
    ],
    [
      'long text',
      { ...valid, values: { agree: true, note: 'x'.repeat(501) } },
      /longer than 500/,
    ],
    [
      'unknown value',
      { ...valid, values: { agree: true, nope: 'x' } },
      /Unknown value field nope/,
    ],
    [
      'signature sent as value',
      { ...valid, values: { agree: true, sig: 'x' } },
      /Unknown value field sig/,
    ],
    [
      'unknown signature',
      {
        ...valid,
        signatures: { ...valid.signatures, name: { mode: 'typed', text: 'x' } },
      },
      /Unknown signature field name/,
    ],
    [
      'bad mode',
      { ...valid, signatures: { sig: { mode: 'stamp' } } },
      /must be \{ mode/,
    ],
    [
      'signature not an object',
      { ...valid, signatures: { sig: 'x' } },
      /must be \{ mode/,
    ],
    [
      'png not a string',
      { ...valid, signatures: { sig: { mode: 'drawn', png: 1 } } },
      /base64 PNG/,
    ],
    [
      'png not base64',
      { ...valid, signatures: { sig: { mode: 'drawn', png: '@@@@' } } },
      /not valid base64/,
    ],
    [
      'not a png',
      {
        ...valid,
        signatures: {
          sig: { mode: 'drawn', png: Buffer.from('GIF89a').toString('base64') },
        },
      },
      /not a PNG/,
    ],
    [
      'long typed signature',
      {
        ...valid,
        signatures: { sig: { mode: 'typed', text: 'x'.repeat(101) } },
      },
      /longer than 100/,
    ],
  ])('rejects %s', (_name, body, message) => {
    expect(() => parse(body)).toThrow(message);
  });

  it('rejects PNGs over 200 KB, whether the base64 is long or the bytes are', () => {
    const big = Buffer.alloc(MAX_SIGNATURE_PNG_BYTES + 1);
    signaturePng(10, 10).copy(big);
    expect(() =>
      parse({
        ...valid,
        signatures: {
          sig: {
            mode: 'drawn',
            png: Buffer.concat([big, big]).toString('base64'),
          },
        },
      }),
    ).toThrow(/larger than 200 KB/);
    const justOver = big
      .subarray(0, MAX_SIGNATURE_PNG_BYTES + 1)
      .toString('base64');
    expect(() =>
      parse({
        ...valid,
        signatures: { sig: { mode: 'drawn', png: justOver } },
      }),
    ).toThrow(SigningInputError);
    const atLimit = big.subarray(0, MAX_SIGNATURE_PNG_BYTES).toString('base64');
    expect(() =>
      parse({ ...valid, signatures: { sig: { mode: 'drawn', png: atLimit } } }),
    ).not.toThrow();
  });

  it('prefills a text field with the signer name and requires blank required text', () => {
    expect(
      parse({ signerName: 'A' }, [field('t', 'text', { prefill: 'full_name' })])
        .values,
    ).toEqual({ t: 'A' });
    expect(() => parse({ signerName: 'A' }, [field('t', 'text')])).toThrow(
      /Field t \(t\) is required/,
    );
  });

  it('defaults missing values and signatures to empty', () => {
    expect(
      parse({ signerName: 'A' }, [field('note', 'text', { required: false })]),
    ).toEqual({ signerName: 'A', values: {}, signatures: {}, fieldValues: {} });
  });
});
