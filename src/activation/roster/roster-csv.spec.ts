import {
  RosterCsvError,
  parseDateOfBirth,
  parseRosterCsv,
  pickDisplayName,
  splitLegalName,
} from './roster-csv';
import { ROSTER_HEADER, rosterCsv } from './roster-fixtures.test-util';

const TODAY = new Date('2026-10-11T00:00:00Z');

describe('parseDateOfBirth', () => {
  it.each([
    ['1/2/1990', '1990-01-02'],
    ['12/31/2000', '2000-12-31'],
    [' 02/29/2004 ', '2004-02-29'],
  ])('parses %s', (input, iso) => {
    expect(parseDateOfBirth(input, TODAY)).toEqual({
      value: iso,
      status: 'ok',
    });
  });

  it.each([
    '2/30/1990',
    '13/1/1990',
    '1990-01-02',
    '1/2/90',
    '1/1/1850',
    '1/1/2027',
    'soon',
  ])('flags %s as invalid', (input) => {
    expect(parseDateOfBirth(input, TODAY)).toEqual({
      value: null,
      status: 'invalid',
    });
  });

  it('treats blank as missing', () => {
    expect(parseDateOfBirth('  ', TODAY)).toEqual({
      value: null,
      status: 'missing',
    });
  });

  it('defaults "today" to now', () => {
    expect(parseDateOfBirth('1/1/1990').status).toBe('ok');
  });
});

describe('pickDisplayName', () => {
  it('uses the trimmed preferred name', () => {
    expect(pickDisplayName('  Kiki   Snow ', 'Kristina Q Public')).toEqual({
      value: 'Kiki Snow',
      source: 'preferred',
    });
  });

  it("falls back to the legal name's first token only", () => {
    expect(pickDisplayName('', '  Kristina Q Public ')).toEqual({
      value: 'Kristina',
      source: 'legal_first_token',
    });
  });

  it('returns blank when both are empty', () => {
    expect(pickDisplayName(' ', '')).toEqual({ value: '', source: 'none' });
  });

  it('caps at 100 characters', () => {
    expect(pickDisplayName('x'.repeat(150), '').value).toHaveLength(100);
    expect(pickDisplayName('', 'y'.repeat(150)).value).toHaveLength(100);
  });
});

describe('splitLegalName', () => {
  it.each([
    ['Xiao Li Liu', 'Xiao Li', 'Liu'],
    ['  Xiao   Li\tLiu ', 'Xiao Li', 'Liu'],
    ['MO WANG', 'Mo', 'Wang'],
    ['mo wang', 'Mo', 'Wang'],
    ['I-HSIANG TUNG', 'I-Hsiang', 'Tung'],
    ['zhi-gang wu', 'Zhi-Gang', 'Wu'],
    ['Yi wei Zhang', 'Yi wei', 'Zhang'],
    ['McKay DE la Cruz', 'McKay DE la', 'Cruz'],
  ])('splits %j into %j and %j', (legal, firstName, lastName) => {
    expect(splitLegalName(legal)).toEqual({ firstName, lastName });
  });

  it.each(['', '   ', 'Madonna', '  CHER  '])(
    'leaves both null for %j',
    (legal) => {
      expect(splitLegalName(legal)).toEqual({
        firstName: null,
        lastName: null,
      });
    },
  );

  it('accepts parts of exactly 100 characters', () => {
    const part = `A${'b'.repeat(99)}`;
    expect(splitLegalName(`${part} ${part}`)).toEqual({
      firstName: part,
      lastName: part,
    });
  });

  it('leaves both null when either part is over 100 characters', () => {
    const long = `A${'b'.repeat(100)}`;
    const none = { firstName: null, lastName: null };
    expect(splitLegalName(`${long} Smith`)).toEqual(none);
    expect(splitLegalName(`Jo ${long}`)).toEqual(none);
    expect(splitLegalName(`${'Ab '.repeat(34)}Smith`)).toEqual(none);
  });
});

describe('parseRosterCsv', () => {
  it('maps every column and never keeps the phone, address or SIN', () => {
    const result = parseRosterCsv(
      rosterCsv([
        {
          preferred: 'Avery',
          certs: 'CSIA L2, CASI Park 1',
          locations: 'MSL, Blue Mountain',
          legal: 'Avery Example Person',
          dob: '3/4/1995',
          email: ' Avery@Example.TEST ',
        },
        {
          preferred: '',
          certs: 'CASI L3 Partial (Please specify in "Other"), Td',
          details: 'CASI Level 3 riding 2025',
          locations: 'Lakeridge (Weekdays only)',
          legal: 'Blake Sample',
          dob: '31/12/1990',
          email: 'blake@example.test',
        },
      ]),
      TODAY,
    );
    expect(result.invalidEmailLines).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.entries).toEqual([
      {
        line: 2,
        email: 'avery@example.test',
        displayNameEn: 'Avery',
        displayNameSource: 'preferred',
        firstName: 'Avery Example',
        lastName: 'Person',
        dateOfBirth: '1995-03-04',
        dateOfBirthStatus: 'ok',
        certifications: [
          {
            org: 'csia',
            track: 'regular',
            level: 2,
            isPartial: false,
            partialComponents: [],
            source: 'rule',
          },
          {
            org: 'casi',
            track: 'park',
            level: 1,
            isPartial: false,
            partialComponents: [],
            source: 'rule',
          },
        ],
        trainerStatus: [],
        unmappedCertifications: [],
        locationKeys: [
          'teaching_location.moonstone',
          'teaching_location.blue_mountain',
        ],
        llmLocationKeys: [],
        unmappedLocations: [],
        llmRejected: [],
        llmResolved: [],
        raw: {
          certifications: 'CSIA L2, CASI Park 1',
          certificationDetails: '',
          locations: 'MSL, Blue Mountain',
        },
        needsReview: false,
      },
      {
        line: 3,
        email: 'blake@example.test',
        displayNameEn: 'Blake',
        displayNameSource: 'legal_first_token',
        firstName: 'Blake',
        lastName: 'Sample',
        dateOfBirth: null,
        dateOfBirthStatus: 'invalid',
        certifications: [
          {
            org: 'casi',
            track: 'regular',
            level: 3,
            isPartial: true,
            partialComponents: ['riding'],
            source: 'rule',
          },
        ],
        trainerStatus: [
          {
            discipline: 'snowboard',
            rookieSessionCompleted: true,
            trainerExamPassed: true,
            trainerLevel: 1,
            source: 'rule',
          },
        ],
        unmappedCertifications: [],
        locationKeys: ['teaching_location.lakeridge'],
        llmLocationKeys: [],
        unmappedLocations: [],
        llmRejected: [],
        llmResolved: [],
        raw: {
          certifications: 'CASI L3 Partial (Please specify in "Other"), Td',
          certificationDetails: 'CASI Level 3 riding 2025',
          locations: 'Lakeridge (Weekdays only)',
        },
        needsReview: true,
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const secret of ['555-0100', 'Fake Street', '000000000']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('skips invalid emails and keeps the last of repeated emails', () => {
    const result = parseRosterCsv(
      rosterCsv([
        { preferred: 'First', email: 'casey@example.test' },
        { preferred: 'Nobody', email: 'not-an-email' },
        { preferred: 'Nobody' },
        { preferred: 'Second', email: 'CASEY@example.test' },
      ]),
      TODAY,
    );
    expect(result.invalidEmailLines).toEqual([3, 4]);
    expect(result.duplicates).toEqual([
      { email: 'casey@example.test', lines: [2, 5] },
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      line: 5,
      displayNameEn: 'Second',
      dateOfBirthStatus: 'missing',
    });
  });

  it('reads exports without the "when and where" column', () => {
    const header = ROSTER_HEADER.filter((h) => !h.startsWith('When and where'));
    const csv = `${header.join(',')}\n9/1/2026,Dana,wx,CSIA L2,MSL,Dana X,1,2,1/1/1990,dana@example.test,0\n`;
    expect(parseRosterCsv(csv, TODAY).entries[0]).toMatchObject({
      raw: { certificationDetails: '' },
      certifications: [{ org: 'csia', level: 2 }],
    });
  });

  it('tolerates rows shorter than the header', () => {
    const csv = `${ROSTER_HEADER.join(',')}\n9/1/2026,Dana\n`;
    expect(parseRosterCsv(csv, TODAY).invalidEmailLines).toEqual([2]);
  });

  it('rejects an empty file or missing columns', () => {
    expect(() => parseRosterCsv('', TODAY)).toThrow(RosterCsvError);
    expect(() => parseRosterCsv('Timestamp,Email Address\n', TODAY)).toThrow(
      /missing column\(s\): preferred name, highest instructor certification/,
    );
  });

  it('defaults "today" to now', () => {
    expect(
      parseRosterCsv(rosterCsv([{ email: 'e@example.test', dob: '1/1/1990' }]))
        .entries[0].dateOfBirth,
    ).toBe('1990-01-01');
  });
});
