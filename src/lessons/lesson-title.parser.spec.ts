import {
  buildInstructorHandleIndex,
  isLessonCandidate,
  parseCount,
  suggestLessonProduct,
} from './lesson-title.parser';
import type { LessonSuggestion } from './lessons.types';

const EDDIE = '0b6f4c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';
const ERIC = '1c7a5d2f-3b4e-4f6a-9b0c-1d2e3f4a5b6c';
const TWIN_A = '2d8b6e3a-4c5f-4a7b-8c1d-2e3f4a5b6c7d';
const TWIN_B = '3e9c7f4b-5d6a-4b8c-9d2e-3f4a5b6c7d8e';

const index = buildInstructorHandleIndex([
  { id: EDDIE, displayNameEn: 'Eddie', shopifyHandle: 'eddie' },
  { id: ERIC, displayNameEn: 'Eric Wang', shopifyHandle: null },
  { id: TWIN_A, displayNameEn: 'Sam Lee', shopifyHandle: null },
  { id: TWIN_B, displayNameEn: 'Sam  Lee', shopifyHandle: 'sam-lee-2' },
]);

const suggestion = (
  overrides: Partial<LessonSuggestion> = {},
): LessonSuggestion => ({
  lessonType: 'other',
  groupSize: null,
  sessions: null,
  durationMin: null,
  pricedPerStudent: false,
  instructorId: null,
  ...overrides,
});

describe('suggestLessonProduct on real store titles', () => {
  it.each<[string, string, string | null, string[], LessonSuggestion]>([
    [
      'Eddie 1:1 single',
      '一对一',
      '单次',
      ['eddie'],
      suggestion({
        lessonType: 'private',
        groupSize: 1,
        sessions: 1,
        instructorId: EDDIE,
      }),
    ],
    [
      'Eddie 1:1 four-pack',
      '一对一',
      '四次',
      ['eddie'],
      suggestion({
        lessonType: 'private',
        groupSize: 1,
        sessions: 4,
        instructorId: EDDIE,
      }),
    ],
    [
      'Eddie 1:2 single, per student',
      '一对二',
      '单次 每位学员单价',
      ['eddie'],
      suggestion({
        lessonType: 'semi_private',
        groupSize: 2,
        sessions: 1,
        pricedPerStudent: true,
        instructorId: EDDIE,
      }),
    ],
    [
      'Eddie 1:2 four-pack, per student',
      '一对二',
      '四次 每位学员单价',
      ['eddie'],
      suggestion({
        lessonType: 'semi_private',
        groupSize: 2,
        sessions: 4,
        pricedPerStudent: true,
        instructorId: EDDIE,
      }),
    ],
    [
      'Eric Wang 1:3 four-pack, per student',
      '一对三',
      '四次 每位学员单价',
      ['eric-wang'],
      suggestion({
        lessonType: 'semi_private',
        groupSize: 3,
        sessions: 4,
        pricedPerStudent: true,
        instructorId: ERIC,
      }),
    ],
    [
      'Eric Wang group single, per student',
      '团课',
      '单次 每位学员单价',
      ['eric-wang', 'all-lessons'],
      suggestion({
        lessonType: 'group',
        sessions: 1,
        pricedPerStudent: true,
        instructorId: ERIC,
      }),
    ],
    [
      'own-student 1v1 in private-lessons',
      'Jamie',
      '1v1',
      ['private-lessons'],
      suggestion({ lessonType: 'private', groupSize: 1 }),
    ],
    [
      'own-student 1v3 in private-lessons',
      'Richard',
      '1v3',
      ['private-lessons'],
      suggestion({ lessonType: 'semi_private', groupSize: 3 }),
    ],
    [
      'own-student variant naming the instructor',
      'Elaine & Tiger',
      '1v2 / Tiger',
      ['private-lessons'],
      suggestion({ lessonType: 'semi_private', groupSize: 2 }),
    ],
    [
      'instructor insurance is not a lesson',
      '教练私课保险',
      '2小时 / 3',
      ['private-lessons'],
      suggestion({ durationMin: 120 }),
    ],
    [
      'season insurance',
      '教练私课保险',
      '整季 / 不限',
      ['private-lessons'],
      suggestion(),
    ],
    [
      'camp product',
      'Blue Mountain 4 Day Elite Camp - 2027',
      'Default Title',
      ['camps'],
      suggestion(),
    ],
  ])('%s', (_label, productTitle, variantTitle, handles, expected) => {
    expect(
      suggestLessonProduct(
        { productTitle, variantTitle, collectionHandles: handles },
        index,
      ),
    ).toEqual(expected);
  });
});

describe('suggestLessonProduct edge cases', () => {
  const parse = (
    productTitle: string,
    variantTitle: string | null = null,
    collectionHandles: string[] = [],
  ) =>
    suggestLessonProduct(
      { productTitle, variantTitle, collectionHandles },
      index,
    );

  it.each([
    ['十次', 10],
    ['十二次', 12],
    ['二十次', 20],
    ['两次', 2],
    ['8次', 8],
    ['8 次', 8],
  ])('reads %s as %i sessions', (variant, sessions) => {
    expect(parse('一对一', variant).sessions).toBe(sessions);
  });

  it('leaves sessions empty when the titles disagree or are unreadable', () => {
    expect(parse('一对一 单次', '四次').sessions).toBeNull();
    expect(parse('一对一', '一二次').sessions).toBeNull();
  });

  it('falls back to other when two lesson types appear', () => {
    expect(parse('一对一', '团课')).toMatchObject({
      lessonType: 'other',
      groupSize: null,
    });
  });

  it('accepts full-width and upper-case ratio spellings', () => {
    expect(parse('１V２')).toMatchObject({
      lessonType: 'semi_private',
      groupSize: 2,
    });
    expect(parse('1对1')).toMatchObject({ lessonType: 'private' });
  });

  it('reads minute durations', () => {
    expect(parse('一对一', '90分钟').durationMin).toBe(90);
    expect(parse('一对一', '1.5 hours').durationMin).toBe(90);
  });

  it('treats an unknown ratio as other', () => {
    expect(parse('一对零').lessonType).toBe('other');
  });

  it('matches instructor handles case-insensitively', () => {
    expect(parse('一对一', null, [' Eddie ']).instructorId).toBe(EDDIE);
  });

  it('refuses to pick between two instructors sharing a slug', () => {
    expect(parse('一对一', null, ['sam-lee']).instructorId).toBeNull();
    expect(parse('一对一', null, ['sam-lee-2']).instructorId).toBe(TWIN_B);
  });

  it('refuses to pick when collections name different instructors', () => {
    expect(parse('一对一', null, ['eddie', 'eric-wang']).instructorId).toBe(
      null,
    );
  });
});

describe('parseCount', () => {
  it.each([
    ['1', 1],
    ['0', null],
    ['', null],
    ['一', 1],
    ['九', 9],
    ['十', 10],
    ['十九', 19],
    ['九十九', 99],
    ['一二', null],
    ['十十', null],
  ])('%j → %j', (text, expected) => {
    expect(parseCount(text)).toBe(expected);
  });
});

describe('buildInstructorHandleIndex', () => {
  it('skips names without latin characters and blank handles', () => {
    const built = buildInstructorHandleIndex([
      { id: EDDIE, displayNameEn: '小李', shopifyHandle: '  ' },
    ]);
    expect(built.size).toBe(0);
  });

  it('keeps one id when shopify handle and slug agree', () => {
    expect(index.get('eddie')).toBe(EDDIE);
  });
});

describe('isLessonCandidate', () => {
  it('accepts a recognised lesson type or a matched instructor', () => {
    expect(isLessonCandidate(suggestion({ lessonType: 'group' }))).toBe(true);
    expect(isLessonCandidate(suggestion({ instructorId: EDDIE }))).toBe(true);
    expect(isLessonCandidate(suggestion())).toBe(false);
  });
});
