import {
  readySnapshotOf,
  verifiedUpload,
} from '../../test/helpers/shopify-sync-fakes';
import {
  type GoLiveDocument,
  goLiveReadiness,
  type GoLiveSnapshot,
  type GoLiveUpload,
  verifiedCertifications,
} from './go-live';

const TODAY = '2026-10-18';

function upload(overrides: Partial<GoLiveUpload> = {}): GoLiveUpload {
  return { ...verifiedUpload('csia', 'regular', 3), ...overrides };
}

function document(overrides: Partial<GoLiveDocument> = {}): GoLiveDocument {
  return {
    assignmentId: '6b1d2c3e-4f50-4a61-8b72-9c8d7e6f5a40',
    titleEn: 'Instructor agreement',
    titleZh: '教练协议',
    required: true,
    status: 'assigned',
    ...overrides,
  };
}

function goLive(
  overrides: Partial<Omit<GoLiveSnapshot, 'instructor'>> & {
    instructor?: Partial<GoLiveSnapshot['instructor']>;
  } = {},
): GoLiveSnapshot {
  const { certificationUploads, documents, ...rest } = overrides;
  return {
    ...readySnapshotOf(rest),
    certificationUploads: certificationUploads ?? [upload()],
    documents: documents ?? [],
  };
}

describe('goLiveReadiness', () => {
  it('is ready with nothing missing when every requirement holds', () => {
    expect(goLiveReadiness(goLive(), TODAY)).toEqual({
      ready: true,
      missing: [],
      certifications: [
        {
          org: 'csia',
          track: 'regular',
          level: 3,
          status: 'verified',
          validUntil: '2099-12-31',
        },
      ],
    });
  });

  it('lists every empty required profile field', () => {
    const readiness = goLiveReadiness(
      goLive({
        instructor: {
          display_name_en: ' ',
          bio_en: null,
          bio_zh: '',
          profile_photo_url: null,
        },
        locations: [],
        languages: [],
        courseLevels: [],
      }),
      TODAY,
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual([
      { group: 'profile', field: 'displayNameEn' },
      { group: 'profile', field: 'bio' },
      { group: 'profile', field: 'photo' },
      { group: 'profile', field: 'locations' },
      { group: 'profile', field: 'languages' },
      { group: 'profile', field: 'courseLevels' },
    ]);
  });

  it.each([
    ['English', { bio_en: 'Loves powder.', bio_zh: null }],
    ['Chinese', { bio_en: null, bio_zh: '热爱粉雪。' }],
  ])('accepts a bio in %s only', (_language, bio) => {
    expect(goLiveReadiness(goLive({ instructor: bio }), TODAY).ready).toBe(
      true,
    );
  });

  it('does not require the optional profile fields', () => {
    const readiness = goLiveReadiness(
      goLive({
        instructor: {
          display_name_zh: null,
          min_student_age: null,
          photo_2_url: null,
          photo_3_url: null,
        },
        examPreparations: [],
        trainers: [],
      }),
      TODAY,
    );
    expect(readiness.ready).toBe(true);
  });

  describe('certification status', () => {
    const statusOf = (uploads: GoLiveUpload[], level = 3) =>
      goLiveReadiness(
        goLive({
          certifications: [
            { org: 'csia', track: 'regular', level, is_partial: false },
          ],
          certificationUploads: uploads,
        }),
        TODAY,
      ).certifications[0];

    it('is no_proof without an upload', () => {
      expect(statusOf([])).toEqual({
        org: 'csia',
        track: 'regular',
        level: 3,
        status: 'no_proof',
        validUntil: null,
      });
    });

    it('is rejected when the current upload was rejected', () => {
      expect(
        statusOf([upload({ review_status: 'rejected', verified_level: null })])
          .status,
      ).toBe('rejected');
    });

    it('is pending while the current upload awaits review, even past its date', () => {
      expect(
        statusOf([
          upload({
            review_status: 'pending',
            valid_until: '2026-01-01',
            verified_level: null,
          }),
        ]).status,
      ).toBe('pending');
    });

    it('is expired once validUntil is before today, and still verified on the day itself', () => {
      expect(statusOf([upload({ valid_until: '2026-10-17' })])).toMatchObject({
        status: 'expired',
        validUntil: '2026-10-17',
      });
      expect(statusOf([upload({ valid_until: TODAY })]).status).toBe(
        'verified',
      );
    });

    it('is level_mismatch when the proof was verified for a lower level or none', () => {
      expect(statusOf([upload({ verified_level: 2 })]).status).toBe(
        'level_mismatch',
      );
      expect(statusOf([upload({ verified_level: null })]).status).toBe(
        'level_mismatch',
      );
      expect(statusOf([upload({ verified_level: 4 })]).status).toBe('verified');
    });

    it('judges only the latest upload for the org and track', () => {
      expect(
        statusOf([
          upload({ inserted_at: '2026-09-01T00:00:00Z' }),
          upload({
            review_status: 'pending',
            verified_level: null,
            inserted_at: '2026-10-01T00:00:00Z',
          }),
        ]).status,
      ).toBe('pending');
    });
  });

  it('needs at least one verified certification', () => {
    const readiness = goLiveReadiness(
      goLive({
        certifications: [
          { org: 'csia', track: 'regular', level: 3, is_partial: false },
          { org: 'casi', track: 'regular', level: 2, is_partial: false },
        ],
        certificationUploads: [upload({ review_status: 'pending' })],
      }),
      TODAY,
    );
    expect(readiness.missing).toEqual([
      { group: 'certification', reason: 'none_verified' },
    ]);
    expect(readiness.certifications.map((c) => [c.org, c.status])).toEqual([
      ['casi', 'no_proof'],
      ['csia', 'pending'],
    ]);
  });

  it('stays ready when one level is unverified but another is verified', () => {
    const readiness = goLiveReadiness(
      goLive({
        certifications: [
          { org: 'csia', track: 'regular', level: 3, is_partial: false },
          { org: 'casi', track: 'regular', level: 2, is_partial: false },
        ],
      }),
      TODAY,
    );
    expect(readiness.ready).toBe(true);
  });

  it('lists every required document that is not completed, with its titles', () => {
    const readiness = goLiveReadiness(
      goLive({
        documents: [
          document(),
          document({
            assignmentId: '7c2e3d4f-5061-4b72-9c83-0d9e8f7a6b51',
            titleEn: 'Code of conduct',
            titleZh: null,
            status: 'viewed',
          }),
          document({ status: 'completed' }),
          document({ required: false }),
        ],
      }),
      TODAY,
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual([
      {
        group: 'onboarding',
        assignmentId: '6b1d2c3e-4f50-4a61-8b72-9c8d7e6f5a40',
        titleEn: 'Instructor agreement',
        titleZh: '教练协议',
      },
      {
        group: 'onboarding',
        assignmentId: '7c2e3d4f-5061-4b72-9c83-0d9e8f7a6b51',
        titleEn: 'Code of conduct',
        titleZh: null,
      },
    ]);
  });

  it('is not ready until an admin has published the instructor', () => {
    expect(
      goLiveReadiness(goLive({ instructor: { published_at: null } }), TODAY),
    ).toEqual({
      ready: false,
      missing: [{ group: 'review' }],
      certifications: [expect.objectContaining({ status: 'verified' })],
    });
  });

  it('orders missing items profile, certification, onboarding, then review', () => {
    const readiness = goLiveReadiness(
      goLive({
        instructor: { profile_photo_url: null, published_at: null },
        certificationUploads: [],
        documents: [document()],
      }),
      TODAY,
    );
    expect(readiness.missing.map((m) => m.group)).toEqual([
      'profile',
      'certification',
      'onboarding',
      'review',
    ]);
  });

  it.each([
    ['pending', { approval_status: 'pending' }],
    ['rejected', { approval_status: 'rejected' }],
    ['deactivated', { is_active: false }],
  ])(
    'is not ready with nothing missing for a %s instructor, but still reports certifications',
    (_state, instructor) => {
      const readiness = goLiveReadiness(
        goLive({
          instructor: {
            ...instructor,
            profile_photo_url: null,
            published_at: null,
          },
          documents: [document()],
        }),
        TODAY,
      );
      expect(readiness).toEqual({
        ready: false,
        missing: [],
        certifications: [expect.objectContaining({ status: 'verified' })],
      });
    },
  );
});

describe('verifiedCertifications', () => {
  it('keeps only the declared certifications whose proof is verified', () => {
    const certs = verifiedCertifications(
      goLive({
        certifications: [
          { org: 'csia', track: 'regular', level: 3, is_partial: false },
          { org: 'csia', track: 'park', level: 2, is_partial: false },
          { org: 'casi', track: 'regular', level: 2, is_partial: true },
        ],
        certificationUploads: [
          upload(),
          upload({ track: 'park', verified_level: 1 }),
          upload({ org: 'casi', verified_level: 2 }),
        ],
      }),
      TODAY,
    );
    expect(certs).toEqual([
      { org: 'casi', track: 'regular', level: 2, is_partial: true },
      { org: 'csia', track: 'regular', level: 3, is_partial: false },
    ]);
  });
});
