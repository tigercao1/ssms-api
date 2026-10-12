import {
  LOCATION_KEYS,
  RosterCsvError,
  mapCertification,
  mapCertifications,
  mapLocations,
  parseDateOfBirth,
  parseRosterCsv,
  pickDisplayName,
} from './roster-csv';
import { ROSTER_HEADER, rosterCsv } from './roster-fixtures.test-util';

const TODAY = new Date('2026-10-11T00:00:00Z');

describe('mapCertification', () => {
  it.each([
    ['CSIA L1', { org: 'csia', track: 'regular', level: 1 }],
    ['csia l4', { org: 'csia', track: 'regular', level: 4 }],
    [' CASI  L 2 ', { org: 'casi', track: 'regular', level: 2 }],
    ['CASI Park 1', { org: 'casi', track: 'park', level: 1 }],
    ['csia PARK2', { org: 'csia', track: 'park', level: 2 }],
  ])('maps %s', (value, expected) => {
    expect(mapCertification(value)).toEqual(expected);
  });

  it.each([
    'CSIA L5',
    'CASI Park 3',
    'CASI L3 Partial',
    'CASI Carving',
    'L3 Teach',
    'None',
    '',
  ])('rejects %s', (value) => {
    expect(mapCertification(value)).toBeNull();
  });
});

describe('mapCertifications', () => {
  it('keeps the highest level per (org, track) and reports the rest', () => {
    const result = mapCertifications(
      'CSIA L2, CSIA L3, CASI L1, CASI Park 2, CASI Park 1, Other thing, ,CSIA L1',
    );
    expect(result.certifications).toEqual([
      { org: 'csia', track: 'regular', level: 3 },
      { org: 'casi', track: 'regular', level: 1 },
      { org: 'casi', track: 'park', level: 2 },
    ]);
    expect(result.unmapped).toEqual(['Other thing']);
  });

  it('handles an empty cell', () => {
    expect(mapCertifications('')).toEqual({ certifications: [], unmapped: [] });
  });
});

describe('mapLocations', () => {
  it('maps the four known locations case/space-insensitively and dedupes', () => {
    expect(
      mapLocations('MSL, blue  mountain, Tremblant, Glen Eden, msl, Shanghai'),
    ).toEqual({
      keys: [
        'teaching_location.moonstone',
        'teaching_location.blue_mountain',
        'teaching_location.tremblant',
        'teaching_location.glen_eden',
      ],
      unmapped: ['Shanghai'],
    });
    expect(Object.keys(LOCATION_KEYS)).toHaveLength(4);
  });
});

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

describe('parseRosterCsv', () => {
  it('maps every column and never keeps the legal name, phone, address or SIN', () => {
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
          certs: 'CASI L3 Partial (Please specify in "Other")',
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
        dateOfBirth: '1995-03-04',
        dateOfBirthStatus: 'ok',
        certifications: [
          { org: 'csia', track: 'regular', level: 2 },
          { org: 'casi', track: 'park', level: 1 },
        ],
        unmappedCertifications: [],
        locationKeys: [
          'teaching_location.moonstone',
          'teaching_location.blue_mountain',
        ],
        unmappedLocations: [],
      },
      {
        line: 3,
        email: 'blake@example.test',
        displayNameEn: 'Blake',
        displayNameSource: 'legal_first_token',
        dateOfBirth: null,
        dateOfBirthStatus: 'invalid',
        certifications: [],
        unmappedCertifications: ['CASI L3 Partial (Please specify in "Other")'],
        locationKeys: [],
        unmappedLocations: ['Lakeridge (Weekdays only)'],
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const secret of [
      'Example Person',
      'Sample',
      '555-0100',
      'Fake Street',
      '000000000',
    ]) {
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
