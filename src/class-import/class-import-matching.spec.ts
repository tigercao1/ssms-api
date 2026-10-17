import { csvLine, importCsv } from '../../test/helpers/class-import-fakes';
import { parseImportCsv } from './class-import-csv';
import {
  duplicateRowNos,
  emailKey,
  type MatchContext,
  type MatchInput,
  matchCustomer,
  matchInstructor,
  matchRow,
  matchRows,
  nameKey,
  phoneKey,
  summarize,
} from './class-import-matching';

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const C = 'c0000000-0000-4000-8000-000000000003';
const LT = 'd0000000-0000-4000-8000-000000000004';

const ctx = (overrides: Partial<MatchContext> = {}): MatchContext => ({
  instructors: [
    { id: A, displayNameEn: 'Anna-Marie Lee', displayNameZh: '李安娜' },
    { id: B, displayNameEn: 'Sam', displayNameZh: null },
    { id: C, displayNameEn: 'S.A.M.', displayNameZh: null },
  ],
  calendars: [],
  eventMap: new Map([['Private Lesson 2h', LT]]),
  customers: [],
  importedExternalIds: new Set(),
  now: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

function input(csv: Parameters<typeof csvLine>[0] = {}, rowNo = 1): MatchInput {
  const [parsed] = parseImportCsv(importCsv([csv]));
  return {
    ...parsed,
    rowNo,
    instructorId: null,
    lessonTypeId: null,
    customerId: null,
    manualFields: [],
    classId: null,
  };
}

describe('nameKey', () => {
  it('folds case, width, spaces and punctuation', () => {
    expect(nameKey(' Eric  Wang ')).toBe('ericwang');
    expect(nameKey('Ｅｒｉｃ・Ｗａｎｇ')).toBe('ericwang');
    expect(nameKey('陈 艾迪')).toBe('陈艾迪');
    expect(nameKey(null)).toBe('');
  });
});

describe('matchInstructor', () => {
  it.each([
    ['anna marie LEE', { instructorId: A }],
    ['  Anna-Marie  Lee. ', { instructorId: A }],
    ['李安娜', { instructorId: A }],
    ['Sam', { problem: 'instructor_ambiguous' }],
    ['Nobody', { problem: 'instructor_not_found' }],
    ['x', { problem: 'instructor_not_found' }],
    [null, { problem: 'instructor_not_found' }],
  ])('%j → %j', (name, expected) => {
    expect(matchInstructor(name, ctx())).toEqual(expected);
  });

  it('falls back to calendar summaries only when no display name matches', () => {
    const calendars = [
      { instructorId: B, summary: 'Coach Sammy' },
      { instructorId: A, summary: 'Twin' },
      { instructorId: B, summary: 'twin' },
      { instructorId: C, summary: null },
    ];
    expect(matchInstructor('coach sammy', ctx({ calendars }))).toEqual({
      instructorId: B,
    });
    expect(matchInstructor('Twin', ctx({ calendars }))).toEqual({
      problem: 'instructor_ambiguous',
    });
    expect(matchInstructor('李安娜', ctx({ calendars }))).toEqual({
      instructorId: A,
    });
  });
});

describe('customer keys', () => {
  it.each([
    [' Mei@Example.COM ', 'mei@example.com'],
    ['not-an-email', null],
    [null, null],
  ])('emailKey(%j) → %j', (value, expected) => {
    expect(emailKey(value)).toBe(expected);
  });

  it.each([
    ['+1 (647) 555-0100', '6475550100'],
    ['647.555.0100', '6475550100'],
    ['+86 138 0013 8000', '8613800138000'],
    ['555-01', null],
    [undefined, null],
  ])('phoneKey(%j) → %j', (value, expected) => {
    expect(phoneKey(value)).toBe(expected);
  });

  it('matches by email first, then phone, and ignores ambiguous hits', () => {
    const customers = [
      { id: A, emailKey: 'a@example.com', phoneKey: '6475550100' },
      { id: B, emailKey: 'b@example.com', phoneKey: '6475550100' },
      { id: C, emailKey: 'c@example.com', phoneKey: '4165550199' },
    ];
    expect(matchCustomer('A@example.com', '4165550199', customers)).toBe(A);
    expect(matchCustomer('zzz@example.com', '416-555-0199', customers)).toBe(C);
    expect(matchCustomer(null, '647 555 0100', customers)).toBeNull();
    expect(matchCustomer(null, null, customers)).toBeNull();
  });
});

describe('matchRow', () => {
  it('sets the status from the CSV and the clock', () => {
    const now = new Date('2025-12-20T16:00:00Z');
    expect(matchRow(input(), ctx({ now }), false).statusToSet).toBe(
      'scheduled',
    );
    expect(
      matchRow(input({ end: '2025-12-20T11:00:00-05:00' }), ctx({ now }), false)
        .statusToSet,
    ).toBe('completed');
    expect(
      matchRow(input({ status: 'deleted' }), ctx({ now }), false).statusToSet,
    ).toBe('cancelled');
    expect(
      matchRow(input({ start: 'x' }), ctx({ now }), false).statusToSet,
    ).toBeNull();
  });

  it('keeps manual choices and reports a manual blank instructor', () => {
    const row = {
      ...input({ instructor: 'Nobody', event: 'Unknown' }),
      lessonTypeId: LT,
      customerId: null,
      manualFields: [
        'instructor',
        'lesson_type',
        'customer',
      ] as MatchInput['manualFields'],
    };
    expect(matchRow(row, ctx(), false)).toMatchObject({
      instructorId: null,
      lessonTypeId: LT,
      customerId: null,
      problems: ['instructor_not_found'],
    });
    expect(
      matchRow({ ...row, instructorId: B }, ctx(), false).problems,
    ).toEqual([]);
  });

  it('flags rows already imported unless they are linked to a class', () => {
    const imported = ctx({ importedExternalIds: new Set(['9000001']) });
    expect(matchRow(input(), imported, false).problems).toContain(
      'already_imported',
    );
    expect(
      matchRow({ ...input(), classId: A }, imported, false).problems,
    ).not.toContain('already_imported');
  });

  it('leaves the lesson type unmapped when the event name is blank', () => {
    expect(matchRow(input({ event: '' }), ctx(), false).problems).toContain(
      'lesson_type_unmapped',
    );
  });
});

describe('matchRows and summarize', () => {
  it('marks every repeat of an external id after the first', () => {
    expect(
      [
        ...duplicateRowNos([
          { rowNo: 3, externalId: 'x' },
          { rowNo: 1, externalId: 'x' },
          { rowNo: 2, externalId: 'y' },
          { rowNo: 4, externalId: 'x' },
        ]),
      ].sort(),
    ).toEqual([3, 4]);
  });

  it('counts what the review screen shows', () => {
    const rows = matchRows(
      [
        input({ id: '1', instructor: 'Anna-Marie Lee' }, 1),
        input({ id: '1', instructor: 'Anna-Marie Lee' }, 2),
        input({ id: '2', instructor: 'Sam' }, 3),
        input(
          {
            id: '3',
            instructor: 'Anna-Marie Lee',
            event: 'Group',
            status: 'deleted',
          },
          4,
        ),
        input({ id: '4', instructor: 'Anna-Marie Lee', start: 'bad' }, 5),
      ],
      ctx({ importedExternalIds: new Set(['1']) }),
    );

    expect(summarize(rows)).toEqual({
      total: 5,
      matched: 1,
      willImport: 0,
      needsInstructor: 1,
      needsLessonType: 1,
      customerNotFound: 5,
      cancelled: 1,
      invalid: 1,
      duplicate: 1,
      alreadyImported: 2,
      imported: 0,
    });
    expect(summarize([{ ...rows[0], classId: A }]).imported).toBe(1);
  });
});
