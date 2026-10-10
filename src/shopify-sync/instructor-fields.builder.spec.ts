import { snapshotOf } from '../../test/helpers/shopify-sync-fakes';
import {
  type BuildFieldsOptions,
  buildInstructorFields,
} from './instructor-fields.builder';
import type { InstructorSnapshot, SyncRefName } from './instructor-sync.types';

function refs(...names: string[]): SyncRefName[] {
  return names.map((name) => ({ name, name_zh: null }));
}

function fieldsOf(
  snapshot: InstructorSnapshot,
  options: Partial<BuildFieldsOptions> = {},
): Record<string, string> {
  return Object.fromEntries(
    buildInstructorFields(snapshot, {
      ...options,
      existingEntry: options.existingEntry ?? false,
    }).map((f) => [f.key, f.value]),
  );
}

describe('buildInstructorFields', () => {
  it('writes Chinese base values, lists as JSON, min age as text and the SSMS id', () => {
    const fields = fieldsOf(
      snapshotOf({
        locations: refs('Whistler', 'Blue Mountain'),
        languages: refs('English', 'Mandarin'),
        courseLevels: refs('Beginner', 'Intermediate'),
        examPreparations: refs('CSIA Level 1 prep'),
      }),
    );
    expect(fields).toEqual({
      name: '陈艾迪',
      introduction: '热爱粉雪。',
      client_groups: 'Beginner，Intermediate，CSIA Level 1 prep',
      locations: '["Whistler","Blue Mountain"]',
      languages: '["English","Mandarin"]',
      min_age: '6',
      ssms_id: '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a',
    });
  });

  it('uses the Chinese reference names for the base, falling back to English', () => {
    const fields = fieldsOf(
      snapshotOf({
        locations: [
          { name: 'Whistler', name_zh: '惠斯勒' },
          { name: 'Blue Mountain', name_zh: null },
        ],
        languages: [
          { name: 'English', name_zh: '英语' },
          { name: 'Mandarin', name_zh: ' ' },
        ],
        courseLevels: [{ name: 'Beginner', name_zh: '新手' }],
        examPreparations: [{ name: 'CSIA Level 1 prep', name_zh: null }],
      }),
    );
    expect(fields).toMatchObject({
      client_groups: '新手，CSIA Level 1 prep',
      locations: '["惠斯勒","Blue Mountain"]',
      languages: '["英语","Mandarin"]',
    });
  });

  it('falls back to English name and bio when the Chinese ones are blank', () => {
    const fields = fieldsOf(
      snapshotOf({ instructor: { display_name_zh: '  ', bio_zh: null } }),
    );
    expect(fields.name).toBe('Eddie Chen');
    expect(fields.introduction).toBe('Loves powder.');
  });

  it('omits blank fields on a new entry and clears them on an existing one', () => {
    const snapshot = snapshotOf({
      instructor: { bio_en: ' ', bio_zh: null, min_student_age: null },
    });
    const created = fieldsOf(snapshot);
    expect(created).not.toHaveProperty('introduction');
    expect(created).not.toHaveProperty('type');
    expect(created).not.toHaveProperty('locations');
    expect(created).not.toHaveProperty('min_age');

    const updated = fieldsOf(snapshot, { existingEntry: true });
    expect(updated).toMatchObject({
      introduction: '',
      type: '',
      certification: '',
      client_groups: '',
      locations: '',
      languages: '',
      min_age: '',
    });
  });

  it('never writes legacy-only keys', () => {
    const keys = buildInstructorFields(snapshotOf(), {
      existingEntry: true,
      picture: 'gid://shopify/MediaImage/1',
    }).map((f) => f.key);
    for (const key of ['collection_url', 'sort_order']) {
      expect(keys).not.toContain(key);
    }
  });

  it('writes the picture only when told, and clears it with an empty value', () => {
    expect(fieldsOf(snapshotOf())).not.toHaveProperty('picture');
    expect(
      fieldsOf(snapshotOf(), { picture: 'gid://shopify/MediaImage/7' }).picture,
    ).toBe('gid://shopify/MediaImage/7');
    expect(
      fieldsOf(snapshotOf(), { existingEntry: true, picture: null }).picture,
    ).toBe('');
  });

  it.each(['image_1', 'image_2'] as const)(
    'writes %s only when told, and clears it with an empty value',
    (key) => {
      expect(fieldsOf(snapshotOf())).not.toHaveProperty(key);
      expect(
        fieldsOf(snapshotOf(), { [key]: 'gid://shopify/MediaImage/8' })[key],
      ).toBe('gid://shopify/MediaImage/8');
      expect(
        fieldsOf(snapshotOf(), { existingEntry: true, [key]: null })[key],
      ).toBe('');
      expect(fieldsOf(snapshotOf(), { [key]: null })).not.toHaveProperty(key);
    },
  );

  describe('type', () => {
    it.each([
      ['ski only', { certifications: [cert('csia', 'regular', 2)] }, '双板'],
      [
        'snowboard trainer only',
        { trainers: [{ discipline: 'snowboard' as const, trainer_level: 1 }] },
        '单板',
      ],
      [
        'both',
        {
          certifications: [cert('casi', 'park', 1), cert('csia', 'regular', 1)],
        },
        '双板 | 单板',
      ],
    ])('%s', (_label, overrides, expected) => {
      expect(fieldsOf(snapshotOf(overrides)).type).toBe(expected);
    });

    it('ignores trainer rows without an official level', () => {
      const fields = fieldsOf(
        snapshotOf({ trainers: [{ discipline: 'ski', trainer_level: null }] }),
      );
      expect(fields).not.toHaveProperty('type');
    });
  });

  describe('certification', () => {
    it('lists ski first: highest cert then trainer level, per discipline', () => {
      const fields = fieldsOf(
        snapshotOf({
          certifications: [
            cert('casi', 'regular', 2),
            cert('csia', 'regular', 2),
            cert('csia', 'park', 2),
            cert('csia', 'regular', 3),
          ],
          trainers: [
            { discipline: 'ski', trainer_level: 1 },
            { discipline: 'snowboard', trainer_level: null },
          ],
        }),
      );
      expect(fields.certification).toBe(
        'CSIA Level 3, Ski Trainer Level 1, CASI Level 2',
      );
    });

    it('prefers any regular cert over a higher park or carving one', () => {
      const fields = fieldsOf(
        snapshotOf({
          certifications: [
            cert('casi', 'park', 2),
            cert('casi', 'regular', 1, true),
          ],
        }),
      );
      expect(fields.certification).toBe('CASI Level 1 Partial');
    });

    it('uses the highest park or carving cert when no regular one exists', () => {
      const fields = fieldsOf(
        snapshotOf({
          certifications: [cert('casi', 'carving', 1), cert('casi', 'park', 2)],
          trainers: [{ discipline: 'snowboard', trainer_level: 3 }],
        }),
      );
      expect(fields.certification).toBe(
        'CASI Park Level 2, Snowboard Trainer Level 3',
      );
    });

    it('breaks a level tie between park and carving in favour of park', () => {
      const fields = fieldsOf(
        snapshotOf({
          certifications: [cert('casi', 'carving', 1), cert('casi', 'park', 1)],
        }),
      );
      expect(fields.certification).toBe('CASI Park Level 1');
    });

    it('shows a trainer level on its own when there is no cert', () => {
      const fields = fieldsOf(
        snapshotOf({
          trainers: [
            { discipline: 'snowboard', trainer_level: 2 },
            { discipline: 'ski', trainer_level: 4 },
          ],
        }),
      );
      expect(fields.certification).toBe(
        'Ski Trainer Level 4, Snowboard Trainer Level 2',
      );
    });
  });
});

function cert(
  org: 'csia' | 'casi',
  track: 'regular' | 'park' | 'carving',
  level: number,
  isPartial = false,
) {
  return { org, track, level, is_partial: isPartial };
}
