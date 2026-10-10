import {
  formatPairingCsv,
  PAIRING_CSV_COLUMNS,
  PairingCsvError,
  parseCsv,
  parsePairingCsv,
} from './pairing-csv';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const HEADER = PAIRING_CSV_COLUMNS.join(',');

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

function problemsOf(text: string): string[] {
  try {
    parsePairingCsv(text);
  } catch (err) {
    if (err instanceof PairingCsvError) {
      return err.problems;
    }
    throw err;
  }
  throw new Error('expected parsePairingCsv to throw');
}

describe('formatPairingCsv', () => {
  it('writes the header, quotes awkward values and leaves confirm empty', () => {
    const text = formatPairingCsv([
      {
        instructorId: ID1,
        ssmsNameEn: 'Li, "Vince"',
        ssmsNameZh: '李文森',
        legacyHandle: 'xiao-li',
        legacyName: '小李 Vincent',
        score: 0.7,
      },
      {
        instructorId: ID2,
        ssmsNameEn: 'Zed',
        ssmsNameZh: '',
        legacyHandle: '',
        legacyName: '',
        score: 0,
      },
    ]);
    expect(text).toBe(
      [
        HEADER,
        `${ID1},"Li, ""Vince""",李文森,xiao-li,小李 Vincent,0.70,`,
        `${ID2},Zed,,,,,`,
        '',
      ].join('\n'),
    );
  });

  it('round-trips through parseCsv', () => {
    const text = formatPairingCsv([
      {
        instructorId: ID1,
        ssmsNameEn: 'a,b\nc',
        ssmsNameZh: '',
        legacyHandle: 'h',
        legacyName: 'n',
        score: 1,
      },
    ]);
    expect(parseCsv(text)[1]).toEqual([
      ID1,
      'a,b\nc',
      '',
      'h',
      'n',
      '1.00',
      '',
    ]);
  });
});

describe('parseCsv', () => {
  it('handles CRLF, a BOM and blank lines', () => {
    expect(parseCsv('\uFEFFa,b\r\n\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,"b')).toThrow(PairingCsvError);
  });
});

describe('parsePairingCsv', () => {
  it('returns only rows confirmed with y, in any case', () => {
    const pairs = parsePairingCsv(
      csv(
        `${ID1},Vincent,,xiao-li,小李 Vincent,0.70, Y `,
        `${ID2},Zed,,zed,Zed,1.00,n`,
        `${ID2},Zed,,zed2,Zed,1.00,`,
      ),
    );
    expect(pairs).toEqual([
      { line: 2, instructorId: ID1, legacyHandle: 'xiao-li' },
    ]);
  });

  it('accepts reordered columns', () => {
    const text = [
      'confirm,legacy_handle,instructor_id,ssms_name_en,ssms_name_zh,legacy_name,score',
      `y,xiao-li,${ID1},,,,`,
    ].join('\n');
    expect(parsePairingCsv(text)).toEqual([
      { line: 2, instructorId: ID1, legacyHandle: 'xiao-li' },
    ]);
  });

  it('rejects an empty file and missing columns', () => {
    expect(problemsOf('')).toEqual(['file is empty']);
    expect(problemsOf('instructor_id,legacy_handle\n')).toEqual([
      'missing column(s): ssms_name_en, ssms_name_zh, legacy_name, score, confirm',
    ]);
  });

  it('rejects bad confirm values, bad ids and missing handles', () => {
    expect(
      problemsOf(
        csv(`${ID1},,,h1,,,yes`, `not-a-uuid,,,h2,,,y`, `${ID2},,,,,,y`),
      ),
    ).toEqual([
      'line 2: confirm must be y, n or empty (got "yes")',
      'line 3: instructor_id "not-a-uuid" is not a uuid',
      'line 4: confirmed row has no legacy_handle',
    ]);
  });

  it('refuses the same handle confirmed for two instructors', () => {
    expect(
      problemsOf(csv(`${ID1},,,xiao-li,,,y`, `${ID2},,,xiao-li,,,y`)),
    ).toEqual([
      'legacy_handle "xiao-li" is confirmed more than once (lines 2, 3)',
    ]);
  });

  it('refuses the same instructor confirmed twice', () => {
    expect(problemsOf(csv(`${ID1},,,a,,,y`, `${ID1},,,b,,,y`))).toEqual([
      `instructor_id ${ID1} is confirmed more than once (lines 2, 3)`,
    ]);
  });
});
