import {
  formatCertification,
  formatTrainerStatus,
  CertificationLike,
  TrainerStatusLike,
} from './cert-display.formatter';

describe('formatCertification', () => {
  // Every row in CERTIFICATION_STRUCTURE.md § Display strings, plus edge cases.
  const cases: Array<[string, CertificationLike, string]> = [
    [
      'CSIA Regular L3 full',
      { org: 'csia', track: 'regular', level: 3, isPartial: false },
      'CSIA Level 3',
    ],
    [
      'CSIA Regular L3 partial',
      { org: 'csia', track: 'regular', level: 3, isPartial: true },
      'CSIA Level 3 Partial',
    ],
    [
      'CSIA Park L1',
      { org: 'csia', track: 'park', level: 1, isPartial: false },
      'CSIA Park Level 1',
    ],
    [
      'CASI Regular L4 partial',
      { org: 'casi', track: 'regular', level: 4, isPartial: true },
      'CASI Level 4 Partial',
    ],
    [
      'CASI Park L2',
      { org: 'casi', track: 'park', level: 2, isPartial: false },
      'CASI Park Level 2',
    ],
    [
      'CASI Carving L1',
      { org: 'casi', track: 'carving', level: 1, isPartial: false },
      'CASI Carving Level 1',
    ],
    // Defensive: isPartial omitted entirely is treated as full.
    [
      'CSIA Regular L1 no isPartial flag',
      { org: 'csia', track: 'regular', level: 1 },
      'CSIA Level 1',
    ],
    // Defensive: park/carving never surface "Partial" even if flag leaks true.
    [
      'CSIA Park L2 with stray isPartial=true never shows Partial',
      { org: 'csia', track: 'park', level: 2, isPartial: true },
      'CSIA Park Level 2',
    ],
    [
      'CASI Carving L1 with stray isPartial=true never shows Partial',
      { org: 'casi', track: 'carving', level: 1, isPartial: true },
      'CASI Carving Level 1',
    ],
  ];

  it.each(cases)('formats %s', (_label, input, expected) => {
    expect(formatCertification(input)).toBe(expected);
  });
});

describe('formatTrainerStatus', () => {
  const cases: Array<[string, TrainerStatusLike, string | null]> = [
    [
      'CSIA ski trainer L2',
      { discipline: 'ski', trainerLevel: 2 },
      'CSIA Level 2 Trainer',
    ],
    [
      'CASI snowboard trainer L3',
      { discipline: 'snowboard', trainerLevel: 3 },
      'CASI Level 3 Trainer',
    ],
    [
      'not a trainer (trainerLevel null)',
      { discipline: 'ski', trainerLevel: null },
      null,
    ],
    [
      'not a trainer (trainerLevel undefined)',
      { discipline: 'snowboard' },
      null,
    ],
    // Explicit org override wins over discipline-derived org.
    [
      'explicit org override',
      { org: 'casi', discipline: 'ski', trainerLevel: 1 },
      'CASI Level 1 Trainer',
    ],
  ];

  it.each(cases)('formats %s', (_label, input, expected) => {
    expect(formatTrainerStatus(input)).toBe(expected);
  });
});
