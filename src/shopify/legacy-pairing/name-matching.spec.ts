import {
  nameTokens,
  normaliseName,
  proposePairs,
  scoreNames,
} from './name-matching';

describe('normaliseName', () => {
  it('case-folds and strips spaces and punctuation', () => {
    expect(normaliseName('  Vincent  O’Brien-Li. ')).toBe('vincentobrienli');
  });

  it('keeps Chinese characters and folds full-width forms', () => {
    expect(normaliseName('小李 Ｖｉｎｃｅｎｔ（教练）')).toBe(
      '小李vincent教练',
    );
  });

  it('treats null and undefined as empty', () => {
    expect(normaliseName(null)).toBe('');
    expect(normaliseName(undefined)).toBe('');
  });
});

describe('nameTokens', () => {
  it('splits Chinese runs from Latin runs even without spaces', () => {
    expect(nameTokens('小李Vincent')).toEqual(['小李', 'vincent']);
    expect(nameTokens('Vincent小李')).toEqual(['vincent', '小李']);
    expect(nameTokens('Ann-Marie 王')).toEqual(['ann', 'marie', '王']);
  });
});

describe('scoreNames', () => {
  it('scores an exact normalised match as 1', () => {
    expect(scoreNames('Vincent Li', 'vincent-li', null)).toBe(1);
    expect(scoreNames('李 文森', null, '李文森')).toBe(1);
  });

  it('scores a mixed Chinese/English legacy name well against the matching instructor', () => {
    const match = scoreNames('小李 Vincent', 'Vincent Li', '李文森');
    const other = scoreNames('小李 Vincent', 'Sarah Chen', '陈莎拉');
    expect(match).toBeGreaterThanOrEqual(0.5);
    expect(match).toBeLessThan(1);
    expect(other).toBeLessThan(0.3);
  });

  it('matches the English nickname alone against the English display name', () => {
    expect(scoreNames('Vincent', 'Vincent', null)).toBe(1);
    expect(scoreNames('小李 Vincent', 'Vincent', null)).toBeGreaterThanOrEqual(
      0.5,
    );
  });

  it('matches on the Chinese part when there is no English name', () => {
    expect(scoreNames('李文森 Vince', null, '李文森')).toBeGreaterThanOrEqual(
      0.5,
    );
  });

  it('tolerates small spelling differences', () => {
    expect(scoreNames('Vincant Li', 'Vincent Li', null)).toBeGreaterThan(0.8);
  });

  it('returns 0 when either side has no usable name', () => {
    expect(scoreNames('   ', 'Vincent', null)).toBe(0);
    expect(scoreNames('Vincent', null, '')).toBe(0);
  });
});

describe('proposePairs', () => {
  const legacy = [
    { handle: 'xiao-li', name: '小李 Vincent' },
    { handle: 'sarah', name: 'Sarah 陈' },
    { handle: 'vince-k', name: 'Vince K' },
  ];

  it('lists the best candidates first for each instructor', () => {
    const rows = proposePairs(
      [{ id: 'i1', displayNameEn: 'Vincent Li', displayNameZh: '李文森' }],
      legacy,
    );
    expect(rows[0]).toMatchObject({
      instructorId: 'i1',
      ssmsNameEn: 'Vincent Li',
      ssmsNameZh: '李文森',
      legacyHandle: 'xiao-li',
      legacyName: '小李 Vincent',
    });
    expect(rows.map((r) => r.legacyHandle)).not.toContain('sarah');
    const scores = rows.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('caps candidates per instructor', () => {
    const rows = proposePairs(
      [{ id: 'i1', displayNameEn: 'Vincent', displayNameZh: null }],
      legacy,
      { perInstructor: 1, minScore: 0 },
    );
    expect(rows).toHaveLength(1);
  });

  it('emits an empty row for instructors without any candidate', () => {
    const rows = proposePairs(
      [{ id: 'i2', displayNameEn: 'Zed', displayNameZh: null }],
      legacy,
    );
    expect(rows).toEqual([
      {
        instructorId: 'i2',
        ssmsNameEn: 'Zed',
        ssmsNameZh: '',
        legacyHandle: '',
        legacyName: '',
        score: 0,
      },
    ]);
  });
});
