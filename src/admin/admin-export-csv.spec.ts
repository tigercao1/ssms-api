import {
  CSV_BOM,
  exportName,
  hasNonAscii,
  instructorExportCsv,
  instructorExportRow,
} from './admin-export-csv';
import type { AdminInstructorRow } from './admin.types';

const HEADER =
  'Name,Email,Phone,Date of Birth,Certifications,MSLM Podium Pass Holder';

function row(overrides: Partial<AdminInstructorRow> = {}): AdminInstructorRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    auth_user_id: '22222222-2222-4222-8222-222222222222',
    email: 'jane@example.com',
    first_name: 'Jane',
    last_name: 'Doe',
    display_name_en: 'Snowy',
    display_name_zh: '简',
    bio_en: null,
    bio_zh: null,
    date_of_birth: '1990-04-05',
    profile_photo_url: null,
    min_student_age: 5,
    display_order: null,
    preferred_language: 'zh-CN',
    approval_status: 'approved',
    is_active: true,
    inserted_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const NO_CERTS = { certifications: [], trainers: [] };

const csvOf = (
  overrides: Partial<AdminInstructorRow> = {},
  mslPassHolder = true,
) =>
  instructorExportCsv([
    instructorExportRow(row(overrides), NO_CERTS, mslPassHolder),
  ]);

const lines = (csv: string) => csv.slice(CSV_BOM.length).split('\r\n');

describe('instructorExportCsv', () => {
  it('starts with a BOM and the English header, ends every line with CRLF', () => {
    const csv = instructorExportCsv([
      instructorExportRow(row(), NO_CERTS, true),
      instructorExportRow(row({ email: 'b@example.com' }), NO_CERTS, false),
    ]);

    expect(csv.startsWith(`\uFEFF${HEADER}\r\n`)).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(lines(csv)).toEqual([
      HEADER,
      'Jane Doe,jane@example.com,,1990-04-05,,TRUE',
      'Jane Doe,b@example.com,,1990-04-05,,FALSE',
      '',
    ]);
  });

  it('answers only the header when nothing matches', () => {
    expect(instructorExportCsv([])).toBe(`\uFEFF${HEADER}\r\n`);
  });

  it('leaves the phone cell empty for every row', () => {
    const csv = instructorExportCsv(
      ['a', 'b', 'c'].map((n) =>
        instructorExportRow(row({ email: `${n}@example.com` }), NO_CERTS, true),
      ),
    );

    expect(
      lines(csv)
        .slice(1, -1)
        .map((line) => line.split(',')[2]),
    ).toEqual(['', '', '']);
  });

  it('writes the date of birth as stored, and a blank cell without one', () => {
    expect(lines(csvOf())[1].split(',')[3]).toBe('1990-04-05');
    expect(lines(csvOf({ date_of_birth: null }))[1]).toBe(
      'Jane Doe,jane@example.com,,,,TRUE',
    );
  });

  it('writes TRUE for an MSL instructor and FALSE for anyone else', () => {
    expect(lines(csvOf({}, true))[1].split(',')[5]).toBe('TRUE');
    expect(lines(csvOf({}, false))[1].split(',')[5]).toBe('FALSE');
  });

  it('quotes commas, quotes and line breaks', () => {
    expect(csvOf({ first_name: 'Snow, "Jane"\nJr' })).toBe(
      `${CSV_BOM}${HEADER}\r\n` +
        '"Snow, ""Jane""\nJr Doe",jane@example.com,,1990-04-05,,TRUE\r\n',
    );
  });

  it.each([
    ['=HYPERLINK("http://x")', `"'=HYPERLINK(""http://x"")"`],
    ['+1@example.com', "'+1@example.com"],
    ['-x@example.com', "'-x@example.com"],
    ['@x.com', "'@x.com"],
    ['\tx@example.com', "'\tx@example.com"],
    ['\rx@example.com', `"'\rx@example.com"`],
  ])('prefixes the formula-like value %j with an apostrophe', (value, cell) => {
    expect(csvOf({ email: value })).toBe(
      `${CSV_BOM}${HEADER}\r\n` + `Jane Doe,${cell},,1990-04-05,,TRUE\r\n`,
    );
  });

  it('guards a formula-like name too', () => {
    expect(csvOf({ first_name: '=1+1', last_name: null })).toContain(
      "\r\n'=1+1,jane@example.com,",
    );
  });
});

describe('instructorExportRow', () => {
  it('lists each body in English, regular, park, carving, then trainer, joined with "; "', () => {
    expect(
      instructorExportRow(
        row(),
        {
          certifications: [
            { org: 'casi', track: 'park', level: 1, is_partial: false },
            { org: 'csia', track: 'park', level: 2, is_partial: false },
            { org: 'casi', track: 'carving', level: 1, is_partial: false },
            { org: 'csia', track: 'regular', level: 3, is_partial: true },
            { org: 'casi', track: 'regular', level: 2, is_partial: false },
          ],
          trainers: [
            { discipline: 'snowboard', trainer_level: 1 },
            { discipline: 'ski', trainer_level: 2 },
          ],
        },
        true,
      ).certifications,
    ).toBe(
      'CSIA Level 3 Partial; CSIA Park Level 2; CSIA Level 2 Trainer; ' +
        'CASI Level 2; CASI Park Level 1; CASI Carving Level 1; CASI Level 1 Trainer',
    );
  });

  it('skips a trainer row without a level', () => {
    expect(
      instructorExportRow(
        row(),
        {
          certifications: [],
          trainers: [{ discipline: 'ski', trainer_level: null }],
        },
        false,
      ).certifications,
    ).toBe('');
  });

  it('leaves certifications empty without a summary', () => {
    expect(instructorExportRow(row(), undefined, false)).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
      phone: '',
      dateOfBirth: '1990-04-05',
      certifications: '',
      mslPassHolder: false,
    });
  });
});

describe('exportName', () => {
  it('uses the legal first and last name, trimmed, with one space', () => {
    expect(
      exportName(row({ first_name: '  Jane ', last_name: ' Doe  ' })),
    ).toBe('Jane Doe');
  });

  it('keeps a non-ASCII legal name as stored', () => {
    expect(exportName(row({ first_name: '小明', last_name: '王' }))).toBe(
      '小明 王',
    );
  });

  it('uses whichever legal name part is set', () => {
    expect(exportName(row({ last_name: null }))).toBe('Jane');
    expect(exportName(row({ first_name: ' ', last_name: 'Doe' }))).toBe('Doe');
  });

  it('falls back to the English display name only when both legal parts are empty, never the Chinese name', () => {
    expect(
      exportName(
        row({ first_name: null, last_name: '', display_name_en: ' Snowy ' }),
      ),
    ).toBe('Snowy');
    expect(
      exportName(
        row({ first_name: null, last_name: null, display_name_en: '' }),
      ),
    ).toBe('');
  });
});

describe('hasNonAscii', () => {
  it.each([
    ['Jane Snow', false],
    ["O'Neil-Smith", false],
    ['José', true],
    ['王小明', true],
    ['Jane “JJ” Doe', true],
  ])('%j → %s', (name, expected) => {
    expect(hasNonAscii(name)).toBe(expected);
  });
});
