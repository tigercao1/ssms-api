import { nameKey, proposeCalendarMatches } from './calendar-matching';

const eddie = {
  id: 'eddie',
  email: 'Eddie@Example.com',
  displayNameEn: 'Eddie Chen',
  displayNameZh: '陈艾迪',
};
const eric = {
  id: 'eric',
  email: 'eric@example.com',
  displayNameEn: 'Eric Wang',
  displayNameZh: null,
};
const amy = {
  id: 'amy',
  email: null,
  displayNameEn: 'Amy',
  displayNameZh: '王 艾米',
};

describe('proposeCalendarMatches', () => {
  it('matches by email on the calendar id or summary, case-insensitively', () => {
    const proposals = proposeCalendarMatches(
      [eddie, eric],
      [
        { id: 'eddie@example.com', summary: 'Eddie' },
        { id: 'abc@group.calendar.google.com', summary: 'ERIC@example.com' },
      ],
    );
    expect(proposals.get('eddie')?.suggestion).toEqual({
      calendarId: 'eddie@example.com',
      calendarSummary: 'Eddie',
      matchedBy: 'email',
    });
    expect(proposals.get('eric')?.suggestion).toMatchObject({
      calendarId: 'abc@group.calendar.google.com',
      matchedBy: 'email',
    });
  });

  it('matches by English or Chinese name on the summary or the id local part', () => {
    const proposals = proposeCalendarMatches(
      [eddie, eric, amy],
      [
        { id: 'xyz@group.calendar.google.com', summary: '陈艾迪' },
        { id: 'eric.wang@gmail.com', summary: 'Ski stuff' },
        { id: 'amy-cal@group.calendar.google.com', summary: '王艾米' },
      ],
    );
    expect(proposals.get('eddie')?.suggestion?.calendarId).toBe(
      'xyz@group.calendar.google.com',
    );
    expect(proposals.get('eric')?.suggestion).toMatchObject({
      calendarId: 'eric.wang@gmail.com',
      matchedBy: 'name',
    });
    expect(proposals.get('amy')?.suggestion?.calendarId).toBe(
      'amy-cal@group.calendar.google.com',
    );
  });

  it('prefers an email match and lists it first', () => {
    const proposal = proposeCalendarMatches(
      [eddie],
      [
        { id: 'eddiechen@gmail.com', summary: 'Eddie Chen' },
        { id: 'eddie@example.com', summary: 'Work' },
      ],
    ).get('eddie');
    expect(proposal?.candidates.map((c) => c.matchedBy)).toEqual([
      'email',
      'name',
    ]);
    expect(proposal?.suggestion?.calendarId).toBe('eddie@example.com');
  });

  it('does not suggest when the name match is ambiguous', () => {
    const twoCalendars = proposeCalendarMatches(
      [eric],
      [
        { id: 'a@group.calendar.google.com', summary: 'Eric Wang' },
        { id: 'b@group.calendar.google.com', summary: 'eric wang' },
      ],
    ).get('eric');
    expect(twoCalendars?.candidates).toHaveLength(2);
    expect(twoCalendars?.suggestion).toBeNull();

    const twin = { ...eric, id: 'eric-2', email: 'eric2@example.com' };
    const twoInstructors = proposeCalendarMatches(
      [eric, twin],
      [{ id: 'c@group.calendar.google.com', summary: 'Eric Wang' }],
    );
    expect(twoInstructors.get('eric')?.suggestion).toBeNull();
    expect(twoInstructors.get('eric-2')?.suggestion).toBeNull();
  });

  it('does not hand a calendar claimed by email to someone else by name', () => {
    const lookalike = {
      ...eric,
      id: 'eddie-lookalike',
      email: null,
      displayNameEn: 'eddie',
    };
    const proposals = proposeCalendarMatches(
      [eddie, lookalike],
      [{ id: 'eddie@example.com', summary: 'eddie@example.com' }],
    );
    expect(proposals.get('eddie')?.suggestion?.matchedBy).toBe('email');
    expect(proposals.get('eddie-lookalike')?.suggestion).toBeNull();
  });

  it('skips calendars already linked to another instructor', () => {
    const proposals = proposeCalendarMatches(
      [eddie, eric],
      [{ id: 'eddie@example.com', summary: 'Eddie' }],
      new Map([['eddie@example.com', 'eric']]),
    );
    expect(proposals.get('eddie')?.candidates).toEqual([]);
    const own = proposeCalendarMatches(
      [eddie],
      [{ id: 'eddie@example.com', summary: 'Eddie' }],
      new Map([['eddie@example.com', 'eddie']]),
    );
    expect(own.get('eddie')?.suggestion?.calendarId).toBe('eddie@example.com');
  });

  it('ignores one-character names and unrelated calendars', () => {
    const shorty = {
      id: 'x',
      email: null,
      displayNameEn: 'X',
      displayNameZh: '王',
    };
    const proposals = proposeCalendarMatches(
      [shorty],
      [
        { id: 'x@group.calendar.google.com', summary: '王' },
        {
          id: 'en.canadian#holiday@group.v.calendar.google.com',
          summary: 'Holidays',
        },
      ],
    );
    expect(proposals.get('x')).toEqual({ candidates: [], suggestion: null });
  });
});

describe('nameKey', () => {
  it('folds case, width, spaces and punctuation', () => {
    expect(nameKey(' Eric  Wang ')).toBe('ericwang');
    expect(nameKey('Ｅｒｉｃ・Ｗａｎｇ')).toBe('ericwang');
    expect(nameKey('陈 艾迪')).toBe('陈艾迪');
    expect(nameKey(null)).toBe('');
  });
});
