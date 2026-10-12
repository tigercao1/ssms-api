import { parseEventName, proposeLessonTypes } from './lesson-type-proposals';

describe('parseEventName', () => {
  it.each([
    [
      '1对1滑雪课 - 2小时',
      { groupSize: 1, durationMin: 120, isPromo: false, openGroup: false },
    ],
    ['1对2滑雪课 - 1小时', { groupSize: 2, durationMin: 60 }],
    ['1对3滑雪课 - 2小时', { groupSize: 3, durationMin: 120 }],
    [
      '1对4/以上 滑雪课 - 2小时',
      { groupSize: null, openGroup: true, durationMin: 120 },
    ],
    [
      '1对4/以上 滑雪课 - 4小时 - 周末团课',
      { groupSize: null, openGroup: true, durationMin: 240, weekend: true },
    ],
    [
      '12.24前特价课 一对一 ',
      { groupSize: 1, durationMin: null, isPromo: true },
    ],
    ['12.24前特价课 一对二', { groupSize: 2, isPromo: true }],
    [
      '12.24前特价课',
      { groupSize: null, durationMin: null, isPromo: true, openGroup: false },
    ],
    ['特价课1小时 Event', { groupSize: null, durationMin: 60, isPromo: true }],
    ['１对２ 90分钟', { groupSize: 2, durationMin: 90 }],
  ])('%s', (name, expected) => {
    expect(parseEventName(name)).toMatchObject(expected);
  });
});

describe('proposeLessonTypes', () => {
  const csv = [
    '"id","event.name","firstName","date.startDate","date.endDate"',
    '"1","1对1滑雪课 - 2小时","A","2026-01-01T14:00:00-05:00","2026-01-01T16:00:00-05:00"',
    '"2","1对1滑雪课 - 2小时","B","2026-01-02T14:00:00-05:00","2026-01-02T16:00:00-05:00"',
    '"3","12.24前特价课","C","2025-12-20T10:00:00-05:00","2025-12-20T12:00:00-05:00"',
    '"4","12.24前特价课 一对一 ","D","2025-12-21T10:00:00-05:00","2025-12-21T12:00:00-05:00"',
    '"5","特价课1小时 Event","E","2025-12-22T10:00:00-05:00","bad"',
    '"6","","F","",""',
  ].join('\n');

  it('proposes one type per event name, busiest first, without personal fields', () => {
    const proposals = proposeLessonTypes(csv);
    expect(proposals).toEqual([
      {
        nameEn: 'Private 2h',
        nameZh: '1对1滑雪课 - 2小时',
        groupSize: 1,
        durationMin: 120,
        isPromo: false,
        bookings: 2,
        observedDurationsMin: [120],
      },
      {
        nameEn: 'Promo Lesson 2h',
        nameZh: '12.24前特价课',
        groupSize: null,
        durationMin: 120,
        isPromo: true,
        bookings: 1,
        observedDurationsMin: [120],
      },
      {
        nameEn: 'Promo Private 2h',
        nameZh: '12.24前特价课 一对一',
        groupSize: 1,
        durationMin: 120,
        isPromo: true,
        bookings: 1,
        observedDurationsMin: [120],
      },
      {
        nameEn: 'Promo Lesson 1h',
        nameZh: '特价课1小时 Event',
        groupSize: null,
        durationMin: 60,
        isPromo: true,
        bookings: 1,
        observedDurationsMin: [],
      },
    ]);
    expect(JSON.stringify(proposals)).not.toMatch(/"A"|firstName/);
  });

  it('keeps English names unique', () => {
    const twin = [
      '"event.name","date.startDate","date.endDate"',
      '"1对1 - 1小时","",""',
      '"1对1滑雪课 1小时","",""',
    ].join('\n');
    expect(proposeLessonTypes(twin).map((p) => p.nameEn)).toEqual([
      'Private 1h',
      'Private 1h (2)',
    ]);
  });

  it('fails clearly when a required column is missing', () => {
    expect(() => proposeLessonTypes('"id","name"\n"1","x"')).toThrow(
      "missing the 'event.name' column",
    );
  });
});
