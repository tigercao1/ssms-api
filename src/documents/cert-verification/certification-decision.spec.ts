import {
  type CertificationExtraction,
  type DeclaredCertification,
  decide,
  nameSimilarity,
} from './certification-decision';

const TODAY = '2026-10-18';

const declared: DeclaredCertification = {
  names: ['Mei Lin Chen', 'Mei Chen'],
  org: 'csia',
  track: 'regular',
  level: 2,
  isPartial: false,
  validUntil: '2027-06-30',
};

function reading(
  overrides: Partial<CertificationExtraction> = {},
): CertificationExtraction {
  return {
    documentType: 'membership_card',
    issuer: "Canadian Ski Instructors' Alliance",
    holderName: 'CHEN, Mei Lin',
    org: 'csia',
    track: 'regular',
    level: 2,
    isPartial: false,
    validThrough: '2027-06-30',
    memberNumber: '123456',
    legible: true,
    tamperSigns: [],
    confidence: {
      holderName: 0.97,
      org: 0.99,
      track: 0.95,
      level: 0.98,
      validThrough: 0.96,
    },
    notes: '',
    ...overrides,
  };
}

const statusOf = (r: ReturnType<typeof decide>, id: string) =>
  r.checks.find((c) => c.id === id)?.status;

describe('decide', () => {
  it('verifies a document that matches the profile on every check', () => {
    expect(decide(reading(), declared, TODAY).verdict).toBe('verified');
  });

  it('flags a lower level than the profile claims as likely invalid', () => {
    const result = decide(reading({ level: 1 }), declared, TODAY);
    expect(result.verdict).toBe('likely_invalid');
    expect(statusOf(result, 'level')).toBe('fail');
  });

  it('flags an expired membership as likely invalid', () => {
    const result = decide(
      reading({ validThrough: '2026-06-30' }),
      declared,
      TODAY,
    );
    expect(result.verdict).toBe('likely_invalid');
    expect(statusOf(result, 'not_expired')).toBe('fail');
  });

  it('sends a different valid-through date to review and suggests the document date', () => {
    const result = decide(
      reading({ validThrough: '2027-07-31' }),
      declared,
      TODAY,
    );
    expect(result.verdict).toBe('needs_review');
    expect(result.suggestedValidUntil).toBe('2027-07-31');
  });

  it('sends a low-confidence level to review instead of trusting it', () => {
    const result = decide(
      reading({ confidence: { ...reading().confidence, level: 0.6 } }),
      declared,
      TODAY,
    );
    expect(result.verdict).toBe('needs_review');
  });

  it('sends an unreadable document to review', () => {
    expect(decide(reading({ legible: false }), declared, TODAY).verdict).toBe(
      'needs_review',
    );
  });

  it('sends a document with possible edits to review', () => {
    const result = decide(
      reading({ tamperSigns: ['date digits use a different font'] }),
      declared,
      TODAY,
    );
    expect(result.verdict).toBe('needs_review');
  });

  it('rejects a document that is not a certification', () => {
    expect(
      decide(reading({ documentType: 'other' }), declared, TODAY).verdict,
    ).toBe('likely_invalid');
  });

  it('flags someone else’s card', () => {
    const result = decide(
      reading({ holderName: 'John Smith' }),
      declared,
      TODAY,
    );
    expect(result.verdict).toBe('likely_invalid');
    expect(statusOf(result, 'holder_name')).toBe('fail');
  });

  it('never verifies when the date is missing', () => {
    expect(
      decide(reading({ validThrough: null }), declared, TODAY).verdict,
    ).toBe('needs_review');
  });

  it('flags a CASI card uploaded as CSIA proof', () => {
    expect(decide(reading({ org: 'casi' }), declared, TODAY).verdict).toBe(
      'likely_invalid',
    );
  });
});

describe('nameSimilarity', () => {
  it('ignores order, case, punctuation and accents', () => {
    expect(nameSimilarity('CHEN, Mei Lin', 'Mei Lin Chen')).toBe(1);
    expect(nameSimilarity('Zoë Tremblay', 'zoe tremblay')).toBe(1);
  });

  it('scores unrelated names low', () => {
    expect(nameSimilarity('John Smith', 'Mei Lin Chen')).toBeLessThan(0.5);
  });
});
