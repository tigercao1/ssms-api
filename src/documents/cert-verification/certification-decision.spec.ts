import {
  type CertificationExtraction,
  type DeclaredCertification,
  decide,
} from './certification-decision';

const TODAY = '2026-10-18';

function csiaCard(
  overrides: Partial<CertificationExtraction> = {},
): CertificationExtraction {
  return {
    documentType: 'membership_card',
    issuer: "Canadian Ski Instructors' Alliance",
    org: 'csia',
    holderName: 'Mei Lin Chen',
    memberNumber: '260000',
    membershipCategory: null,
    membershipSeason: '2026/2027',
    certifications: [
      {
        text: 'CSIA Regular Level 2 Certified Instructor',
        track: 'regular',
        level: 2,
        isPartial: false,
        confidence: 0.98,
      },
    ],
    validThrough: '2027-09-30',
    recallYear: 2028,
    legible: true,
    tamperSigns: [],
    confidence: {
      holderName: 0.97,
      org: 0.99,
      memberNumber: 0.97,
      validThrough: 0.96,
    },
    notes: '',
    ...overrides,
  };
}

const csiaProfile: DeclaredCertification = {
  legalName: { firstName: 'Mei Lin', lastName: 'Chen' },
  org: 'csia',
  track: 'regular',
  level: 2,
  isPartial: false,
  validUntil: '2027-09-30',
};

const statusOf = (r: ReturnType<typeof decide>, id: string) =>
  r.checks.find((c) => c.id === id)?.status;

describe('decide', () => {
  it('verifies a card that matches the profile on every check', () => {
    expect(decide(csiaCard(), csiaProfile, TODAY).verdict).toBe('verified');
  });

  it('flags a lower level than the profile claims as likely invalid', () => {
    const card = csiaCard({
      certifications: [
        {
          text: 'CSIA Regular Level 1 Certified Instructor',
          track: 'regular',
          level: 1,
          isPartial: false,
          confidence: 0.98,
        },
      ],
    });
    const result = decide(card, csiaProfile, TODAY);
    expect(result.verdict).toBe('likely_invalid');
    expect(statusOf(result, 'level')).toBe('fail');
  });

  it('flags an expired membership as likely invalid', () => {
    const result = decide(
      csiaCard({ validThrough: '2026-09-30' }),
      csiaProfile,
      TODAY,
    );
    expect(result.verdict).toBe('likely_invalid');
    expect(statusOf(result, 'not_expired')).toBe('fail');
  });

  it('sends a different expiry to review and suggests the card date', () => {
    const result = decide(
      csiaCard(),
      { ...csiaProfile, validUntil: '2027-06-30' },
      TODAY,
    );
    expect(result.verdict).toBe('needs_review');
    expect(result.suggestedValidUntil).toBe('2027-09-30');
  });

  it('sends a low-confidence certification line to review', () => {
    const card = csiaCard({
      certifications: [{ ...csiaCard().certifications[0], confidence: 0.6 }],
    });
    expect(decide(card, csiaProfile, TODAY).verdict).toBe('needs_review');
  });

  it('sends an unreadable card to review', () => {
    expect(
      decide(csiaCard({ legible: false }), csiaProfile, TODAY).verdict,
    ).toBe('needs_review');
  });

  it('sends a card with possible edits to review', () => {
    const result = decide(
      csiaCard({ tamperSigns: ['expiry digits use a different font'] }),
      csiaProfile,
      TODAY,
    );
    expect(result.verdict).toBe('needs_review');
  });

  it('rejects a document that is not a membership card', () => {
    expect(
      decide(csiaCard({ documentType: 'other' }), csiaProfile, TODAY).verdict,
    ).toBe('likely_invalid');
  });

  it('flags someone else’s card', () => {
    const result = decide(
      csiaCard({ holderName: 'John Smith' }),
      csiaProfile,
      TODAY,
    );
    expect(result.verdict).toBe('likely_invalid');
    expect(statusOf(result, 'holder_name')).toBe('fail');
  });

  it('never verifies when the expiry is missing', () => {
    expect(
      decide(csiaCard({ validThrough: null }), csiaProfile, TODAY).verdict,
    ).toBe('needs_review');
  });

  it('flags a CASI card uploaded as CSIA proof', () => {
    expect(decide(csiaCard({ org: 'casi' }), csiaProfile, TODAY).verdict).toBe(
      'likely_invalid',
    );
  });

  it('sends a card with no member number to review', () => {
    expect(
      decide(csiaCard({ memberNumber: null }), csiaProfile, TODAY).verdict,
    ).toBe('needs_review');
  });

  it('flags a member number that differs from the one the instructor entered', () => {
    const result = decide(
      csiaCard(),
      { ...csiaProfile, memberNumber: '260001' },
      TODAY,
    );
    expect(result.verdict).toBe('likely_invalid');
    expect(statusOf(result, 'member_number')).toBe('fail');
  });

  it('flags a member number already used on another instructor’s approved card', () => {
    const result = decide(
      csiaCard(),
      { ...csiaProfile, memberNumberUsedByOthers: true },
      TODAY,
    );
    expect(result.verdict).toBe('likely_invalid');
  });

  it('sends a member number that changed since the last approved card to review', () => {
    const result = decide(
      csiaCard(),
      { ...csiaProfile, previousMemberNumbers: ['111111'] },
      TODAY,
    );
    expect(result.verdict).toBe('needs_review');
  });

  it('passes the same member number as the last approved card', () => {
    expect(
      decide(
        csiaCard(),
        { ...csiaProfile, previousMemberNumbers: ['260000'] },
        TODAY,
      ).verdict,
    ).toBe('verified');
  });

  it('ignores the recall year', () => {
    expect(
      decide(csiaCard({ recallYear: 2020 }), csiaProfile, TODAY).verdict,
    ).toBe('verified');
  });
});

describe('decide on the real card layouts', () => {
  const csia2023 = (name: string, level: number, recallYear: number) =>
    csiaCard({
      holderName: name,
      memberNumber: '265390',
      membershipSeason: '2023/2024',
      certifications: [
        {
          text: `CSIA Regular Level ${level} Certified Instructor`,
          track: 'regular',
          level,
          isPartial: false,
          confidence: 0.98,
        },
      ],
      recallYear,
      validThrough: '2024-09-30',
    });

  const casiCard = (overrides: Partial<CertificationExtraction>) =>
    csiaCard({
      issuer: 'Canadian Association of Snowboard Instructors',
      org: 'casi',
      membershipCategory: 'Regular',
      membershipSeason: null,
      recallYear: null,
      ...overrides,
    });

  it('treats last season’s CSIA card as expired', () => {
    const result = decide(
      csia2023('Jiayi Liu', 2, 2026),
      {
        ...csiaProfile,
        legalName: { firstName: 'Jiayi', lastName: 'Liu' },
        validUntil: '2024-09-30',
      },
      TODAY,
    );
    expect(result.verdict).toBe('likely_invalid');
    expect(statusOf(result, 'not_expired')).toBe('fail');
  });

  it('verifies the same CSIA card on a day it was valid', () => {
    const result = decide(
      csia2023('Jiayi Liu', 2, 2026),
      {
        ...csiaProfile,
        legalName: { firstName: 'Jiayi', lastName: 'Liu' },
        validUntil: '2024-09-30',
      },
      '2024-01-15',
    );
    expect(result.verdict).toBe('verified');
  });

  const hongfeng = casiCard({
    holderName: 'Hongfeng He',
    certifications: [
      {
        text: 'Level 2 Snowboard Instructor',
        track: 'regular',
        level: 2,
        isPartial: false,
        confidence: 0.97,
      },
      {
        text: 'Park 1 Instructor',
        track: 'park',
        level: 1,
        isPartial: false,
        confidence: 0.96,
      },
    ],
    validThrough: '2025-05-31',
  });
  const casiProfile = {
    legalName: { firstName: 'Hongfeng', lastName: 'He' },
    org: 'casi' as const,
    isPartial: false,
    validUntil: '2025-05-31',
  };

  it('uses the regular line of a CASI card that lists two certifications', () => {
    const result = decide(
      hongfeng,
      { ...casiProfile, track: 'regular', level: 2 },
      '2025-01-15',
    );
    expect(result.verdict).toBe('verified');
  });

  it('uses the park line of the same card for a park upload', () => {
    const result = decide(
      hongfeng,
      { ...casiProfile, track: 'park', level: 1 },
      '2025-01-15',
    );
    expect(result.verdict).toBe('verified');
  });

  it('does not read the CASI membership category "Regular" as a certification', () => {
    const noLines = casiCard({
      holderName: 'Hongfeng He',
      certifications: [],
      validThrough: '2025-05-31',
    });
    const result = decide(
      noLines,
      { ...casiProfile, track: 'regular', level: 2 },
      '2025-01-15',
    );
    expect(result.verdict).toBe('needs_review');
    expect(statusOf(result, 'track')).toBe('unsure');
  });

  it('flags a carving upload backed by a card with no carving line', () => {
    const result = decide(
      hongfeng,
      { ...casiProfile, track: 'carving', level: 1 },
      '2025-01-15',
    );
    expect(result.verdict).toBe('likely_invalid');
    expect(statusOf(result, 'track')).toBe('fail');
  });
});
