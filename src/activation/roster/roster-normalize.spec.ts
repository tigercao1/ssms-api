import {
  ALLOWED_LOCATION_KEYS,
  describeCertification,
  keepHighest,
  normalizeCertifications,
  normalizeLocations,
  validateCertification,
  type ProposedCertification,
  type RosterCertification,
} from './roster-normalize';

const PARTIAL_FORM_CSIA = 'CSIA L3 Partial (Please specify in "Other")';
const PARTIAL_FORM_CASI = 'CASI L3 Partial (Please specify in "Other")';

function cert(
  org: 'csia' | 'casi',
  track: 'regular' | 'park' | 'carving',
  level: number,
  partialComponents: string[] = [],
  source: 'rule' | 'llm' = 'rule',
): ProposedCertification {
  return {
    org,
    track,
    level,
    isPartial: partialComponents.length > 0,
    partialComponents,
    source,
  };
}

describe('normalizeCertifications: canonical values', () => {
  it.each([
    ['CSIA L1', cert('csia', 'regular', 1)],
    ['csia l4', cert('csia', 'regular', 4)],
    [' CASI  L 2 ', cert('casi', 'regular', 2)],
    ['CASI Park 1', cert('casi', 'park', 1)],
    ['csia PARK2', cert('csia', 'park', 2)],
    ['CSIAL2', cert('csia', 'regular', 2)],
  ])('maps %s without flagging it for review', (value, expected) => {
    expect(normalizeCertifications(value)).toEqual({
      certifications: [expected],
      unresolved: [],
      normalized: false,
    });
  });
});

describe('normalizeCertifications: synonyms', () => {
  it.each([
    ['CSIA LV 2', cert('csia', 'regular', 2)],
    ['casi lvl3', cert('casi', 'regular', 3)],
    ['CSIA Level 4', cert('csia', 'regular', 4)],
    ['Casi2', cert('casi', 'regular', 2)],
    ['CASI P1', cert('casi', 'park', 1)],
    ['CASI Park I', cert('casi', 'park', 1)],
    ['C.S.I.A. L-3', null],
    ['CASI Carving', null],
    ['CASI Carving L2', cert('casi', 'carving', 2)],
  ])('%s', (value, expected) => {
    const result = normalizeCertifications(value);
    expect(result.normalized).toBe(true);
    expect(result.certifications).toEqual(expected ? [expected] : []);
    expect(result.unresolved).toEqual(expected ? [] : [value]);
  });

  it.each([
    'CSIA L5',
    'CASI Park 3',
    'CSIA Carving',
    'CASI Park Carving 1',
    'Td',
    'None',
    'CSIA',
    'L3',
    'CSIA L3 2025',
    'CASI Park 1 partial',
    'CASI Carving partial',
    'CSIA CASI L2',
    'CASI L5 Partial',
    'CSIA L5 ski',
  ])('leaves %s unresolved', (value) => {
    expect(normalizeCertifications(value)).toMatchObject({
      certifications: [],
      unresolved: [value],
    });
  });

  it('handles an empty cell', () => {
    expect(normalizeCertifications('')).toEqual({
      certifications: [],
      unresolved: [],
      normalized: false,
    });
  });
});

describe('normalizeCertifications: partials from the same row', () => {
  it('CASI L3 Partial + "Ped&Teaching" → CASI L3 partial [teaching]', () => {
    expect(
      normalizeCertifications(
        `CSIA L3, ${PARTIAL_FORM_CASI}, Ped&Teaching`,
        '2025 BM',
      ),
    ).toEqual({
      certifications: [
        cert('csia', 'regular', 3),
        cert('casi', 'regular', 3, ['teaching']),
      ],
      unresolved: [],
      normalized: true,
    });
  });

  it('CASI L3 Partial + "CASI L3 riding" → [riding], alongside the park cert', () => {
    expect(
      normalizeCertifications(
        `${PARTIAL_FORM_CASI}, CASI Park 1, CASI L3 riding`,
        '2025 feb',
      ).certifications,
    ).toEqual([
      cert('casi', 'park', 1),
      cert('casi', 'regular', 3, ['riding']),
    ]);
  });

  it('CSIA L3 Partial + "lv 3 teaching" → CSIA L3 partial [teach]', () => {
    expect(
      normalizeCertifications(`${PARTIAL_FORM_CSIA}, lv 3 teaching `),
    ).toMatchObject({
      certifications: [cert('csia', 'regular', 3, ['teach'])],
      unresolved: [],
    });
  });

  it('CSIA L3 Partial + "CSIA LV 3 SKI" → [ski], CASI L2 kept', () => {
    expect(
      normalizeCertifications(`${PARTIAL_FORM_CSIA}, CASI L2, CSIA LV 3 SKI`)
        .certifications,
    ).toEqual([
      cert('casi', 'regular', 2),
      cert('csia', 'regular', 3, ['ski']),
    ]);
  });

  it('CSIA L3 Partial + "L3 Teach" → [teach]', () => {
    expect(
      normalizeCertifications(`${PARTIAL_FORM_CSIA}, L3 Teach`, '2026 Hill')
        .certifications,
    ).toEqual([cert('csia', 'regular', 3, ['teach'])]);
  });

  it('takes components from the "when and where" text', () => {
    expect(
      normalizeCertifications(
        `${PARTIAL_FORM_CASI}, CASI Park 1`,
        'CASI LEVEL 3 Ped TBL',
      ).certifications,
    ).toEqual([
      cert('casi', 'park', 1),
      cert('casi', 'regular', 3, ['teaching']),
    ]);
    expect(
      normalizeCertifications(PARTIAL_FORM_CSIA, 'csia lv 3 teaching 2025')
        .certifications,
    ).toEqual([cert('csia', 'regular', 3, ['teach'])]);
  });

  it('ignores "when and where" text that names no matching level', () => {
    expect(
      normalizeCertifications(
        PARTIAL_FORM_CSIA,
        'Ski club 2024, CSIA L2 ski school, CASI L3 riding',
      ),
    ).toMatchObject({ certifications: [], unresolved: [PARTIAL_FORM_CSIA] });
  });

  it('ignores "when and where" text when the row has no partial', () => {
    expect(
      normalizeCertifications('CSIA L2', 'CSIA L3 ski 2025').certifications,
    ).toEqual([cert('csia', 'regular', 2)]);
  });

  it('a self-named fragment is a partial on its own', () => {
    expect(normalizeCertifications('CSIA L2, CSIA LV 3 SKI')).toEqual({
      certifications: [cert('csia', 'regular', 3, ['ski'])],
      unresolved: [],
      normalized: true,
    });
  });

  it('a partial with no identifiable component stays unresolved', () => {
    expect(
      normalizeCertifications(
        `CSIA L1, ${PARTIAL_FORM_CASI}, CASI Park 1`,
        'CSIA lv1 hill!  Casi l3 partial BM',
      ),
    ).toEqual({
      certifications: [cert('csia', 'regular', 1), cert('casi', 'park', 1)],
      unresolved: [PARTIAL_FORM_CASI],
      normalized: true,
    });
  });

  it('"Td" next to a full cert stays unresolved', () => {
    expect(normalizeCertifications('CSIA L3, Td', 'Csia l3 dg 2025')).toEqual({
      certifications: [cert('csia', 'regular', 3)],
      unresolved: ['Td'],
      normalized: true,
    });
  });

  it('rejects components outside the org vocabulary', () => {
    expect(normalizeCertifications(`${PARTIAL_FORM_CASI}, Ski`)).toMatchObject({
      certifications: [],
      unresolved: [PARTIAL_FORM_CASI, 'Ski'],
    });
    expect(
      normalizeCertifications(`${PARTIAL_FORM_CSIA}, riding`),
    ).toMatchObject({
      certifications: [],
      unresolved: [PARTIAL_FORM_CSIA, 'riding'],
    });
  });

  it('a component fragment with no partial in the row stays unresolved', () => {
    expect(normalizeCertifications('CSIA L2, Ped&Teaching')).toMatchObject({
      certifications: [cert('csia', 'regular', 2)],
      unresolved: ['Ped&Teaching'],
    });
  });

  it('a generic fragment that could belong to either org stays unresolved', () => {
    expect(
      normalizeCertifications(
        `${PARTIAL_FORM_CSIA}, ${PARTIAL_FORM_CASI}, Teaching`,
      ),
    ).toEqual({
      certifications: [],
      unresolved: [PARTIAL_FORM_CSIA, PARTIAL_FORM_CASI, 'Teaching'],
      normalized: true,
    });
  });

  it('a fragment naming its org attaches to that org only', () => {
    expect(
      normalizeCertifications(
        `${PARTIAL_FORM_CSIA}, ${PARTIAL_FORM_CASI}, CASI riding, CSIA ski`,
      ).certifications,
    ).toEqual([
      cert('csia', 'regular', 3, ['ski']),
      cert('casi', 'regular', 3, ['riding']),
    ]);
  });

  it('merges components and becomes full once all of them are held', () => {
    expect(
      normalizeCertifications(`${PARTIAL_FORM_CSIA}, L3 Teach, CSIA LV 3 SKI`)
        .certifications,
    ).toEqual([cert('csia', 'regular', 3)]);
    expect(
      normalizeCertifications(
        `${PARTIAL_FORM_CASI}, riding, teaching, instructor training`,
      ).certifications,
    ).toEqual([cert('casi', 'regular', 3)]);
    expect(
      normalizeCertifications(
        `${PARTIAL_FORM_CASI}, riding, Instructor Training`,
      ).certifications,
    ).toEqual([cert('casi', 'regular', 3, ['instructor_training', 'riding'])]);
  });

  it('a fragment with a component and a park or carving word is unresolved', () => {
    expect(
      normalizeCertifications(`${PARTIAL_FORM_CASI}, Park riding`),
    ).toMatchObject({ unresolved: [PARTIAL_FORM_CASI, 'Park riding'] });
  });
});

describe('normalizeCertifications: highest only per (org, track)', () => {
  it('keeps the highest level and reports the rest', () => {
    expect(
      normalizeCertifications(
        'CSIA L2, CSIA L3, CASI L1, CASI Park 2, CASI Park 1, Other thing, ,CSIA L1',
      ),
    ).toEqual({
      certifications: [
        cert('csia', 'regular', 3),
        cert('casi', 'regular', 1),
        cert('casi', 'park', 2),
      ],
      unresolved: ['Other thing'],
      normalized: true,
    });
  });

  it('a full cert at the same level beats a partial', () => {
    expect(
      normalizeCertifications(`CSIA L3, ${PARTIAL_FORM_CSIA}, L3 Teach`)
        .certifications,
    ).toEqual([cert('csia', 'regular', 3)]);
  });

  it('a higher full beats a lower partial', () => {
    expect(
      normalizeCertifications(`CSIA L4, ${PARTIAL_FORM_CSIA}, L3 Teach`)
        .certifications,
    ).toEqual([cert('csia', 'regular', 4)]);
  });

  it('a higher partial beats a lower full', () => {
    expect(
      normalizeCertifications(`CSIA L2, ${PARTIAL_FORM_CSIA}, L3 Teach`)
        .certifications,
    ).toEqual([cert('csia', 'regular', 3, ['teach'])]);
  });

  it('keepHighest merges same-level partials and prefers rule over llm for an equal full', () => {
    expect(
      keepHighest([
        cert('casi', 'regular', 3, ['riding']),
        cert('casi', 'regular', 3, ['teaching'], 'llm'),
      ]),
    ).toEqual([cert('casi', 'regular', 3, ['riding', 'teaching'], 'llm')]);
    expect(
      keepHighest([
        cert('casi', 'regular', 3, [], 'llm'),
        cert('casi', 'regular', 3),
      ]),
    ).toEqual([cert('casi', 'regular', 3)]);
    expect(
      keepHighest([
        cert('casi', 'regular', 3),
        cert('casi', 'regular', 3, [], 'llm'),
      ]),
    ).toEqual([cert('casi', 'regular', 3)]);
    expect(
      keepHighest([
        cert('casi', 'regular', 3),
        cert('casi', 'regular', 3, ['riding'], 'llm'),
        cert('casi', 'regular', 2, [], 'llm'),
      ]),
    ).toEqual([cert('casi', 'regular', 3)]);
    expect(
      keepHighest([
        cert('csia', 'regular', 3, ['ski']),
        cert('csia', 'regular', 3, ['teach']),
      ]),
    ).toEqual([cert('csia', 'regular', 3)]);
  });

  it('every rule output satisfies the migration 010 constraints', () => {
    const cells = [
      `CSIA L3, ${PARTIAL_FORM_CASI}, Ped&Teaching`,
      `${PARTIAL_FORM_CSIA}, CASI L2, CSIA LV 3 SKI`,
      'CASI L3, CASI Park 1, CASI Carving L1',
      'CSIA L1, CSIA L2, CASI L1, CASI L2, CSIA Park 1',
    ];
    for (const cell of cells) {
      for (const c of normalizeCertifications(cell).certifications) {
        const { source, ...row } = c;
        expect(source).toBe('rule');
        expect(validateCertification(row)).toEqual(row);
      }
    }
  });
});

describe('normalizeLocations', () => {
  it('maps the four known locations case/space-insensitively and dedupes', () => {
    expect(
      normalizeLocations(
        'MSL, blue  mountain, Tremblant, Glen Eden, msl, Shanghai',
      ),
    ).toEqual({
      keys: [
        'teaching_location.moonstone',
        'teaching_location.blue_mountain',
        'teaching_location.tremblant',
        'teaching_location.glen_eden',
      ],
      unresolved: ['Shanghai'],
      normalized: true,
    });
    expect(ALLOWED_LOCATION_KEYS).toHaveLength(4);
  });

  it('does not flag canonical values for review', () => {
    expect(normalizeLocations('Blue Mountain, MSL, glen eden')).toMatchObject({
      normalized: false,
    });
  });

  it.each([
    ['BM', 'teaching_location.blue_mountain'],
    ['Blue Mtn.', 'teaching_location.blue_mountain'],
    ['Moonstone', 'teaching_location.moonstone'],
    ['Mt. St. Louis Moonstone', 'teaching_location.moonstone'],
    ['Mont-Tremblant', 'teaching_location.tremblant'],
    ['Blue Mountain (weekends only)', 'teaching_location.blue_mountain'],
  ])('maps %s', (value, key) => {
    expect(normalizeLocations(value)).toEqual({
      keys: [key],
      unresolved: [],
      normalized: true,
    });
  });

  it.each([
    'Mostly West Coast this year :) I may comeback to BM',
    'Lakeridge (Weekdays only)',
    'Ottawa Region',
    'Shanghai ',
  ])('leaves %s unresolved', (value) => {
    expect(normalizeLocations(value)).toEqual({
      keys: [],
      unresolved: [value.trim()],
      normalized: true,
    });
  });
});

describe('validateCertification', () => {
  const ok: RosterCertification = cert('csia', 'regular', 3, ['ski']);
  const strip = ({ source, ...rest }: ProposedCertification) => {
    void source;
    return rest;
  };

  it.each([
    strip(cert('csia', 'regular', 1)),
    strip(cert('casi', 'regular', 4, ['riding', 'teaching'])),
    strip(cert('casi', 'park', 2)),
    strip(cert('casi', 'carving', 1)),
  ])('accepts %j', (value) => {
    expect(validateCertification(value)).toEqual(value);
  });

  it('turns a partial holding every component into a full cert', () => {
    expect(
      validateCertification({ ...ok, partialComponents: ['teach', 'ski'] }),
    ).toEqual(strip(cert('csia', 'regular', 3)));
  });

  it.each([
    ['not an object', 'CSIA L3'],
    ['array', [ok]],
    ['null', null],
    ['unknown org', { ...ok, org: 'pso' }],
    ['unknown track', { ...ok, track: 'moguls' }],
    ['regular level 5', { ...ok, level: 5 }],
    ['regular level 0', { ...ok, level: 0 }],
    ['fractional level', { ...ok, level: 2.5 }],
    ['string level', { ...ok, level: '3' }],
    ['park level 3', strip(cert('casi', 'park', 3))],
    [
      'partial park',
      {
        ...strip(cert('casi', 'park', 1)),
        isPartial: true,
        partialComponents: ['riding'],
      },
    ],
    ['carving for CSIA', strip(cert('csia', 'carving', 1))],
    [
      'partial carving',
      {
        ...strip(cert('casi', 'carving', 1)),
        isPartial: true,
        partialComponents: ['riding'],
      },
    ],
    ['carving level 5', strip(cert('casi', 'carving', 5))],
    ['partial without components', { ...ok, partialComponents: [] }],
    ['full with components', { ...ok, isPartial: false }],
    [
      'component outside csia vocabulary',
      { ...ok, partialComponents: ['riding'] },
    ],
    [
      'component outside casi vocabulary',
      { ...ok, org: 'casi', partialComponents: ['teach'] },
    ],
    ['duplicate components', { ...ok, partialComponents: ['ski', 'ski'] }],
    ['non-string component', { ...ok, partialComponents: [1] }],
    ['components not an array', { ...ok, partialComponents: 'ski' }],
    [
      'isPartial missing',
      { org: 'csia', track: 'regular', level: 3, partialComponents: [] },
    ],
  ])('rejects %s', (_label, value) => {
    expect(validateCertification(value)).toBeNull();
  });
});

describe('describeCertification', () => {
  it.each([
    [cert('csia', 'regular', 3), 'CSIA Level 3'],
    [
      cert('casi', 'regular', 3, ['riding', 'teaching']),
      'CASI Level 3 Partial [riding, teaching]',
    ],
    [cert('csia', 'park', 1), 'CSIA Park Level 1'],
    [cert('casi', 'carving', 1), 'CASI Carving Level 1'],
  ])('%j → %s', (value, label) => {
    expect(describeCertification(value)).toBe(label);
  });
});
