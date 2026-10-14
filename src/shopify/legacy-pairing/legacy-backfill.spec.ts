import sharp from 'sharp';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyInstructorBackfill,
  BACKFILL_AUDIT_ACTION,
  type BackfillInstructor,
  isMeaningfulBio,
  parseLegacyTrainer,
  planInstructorBackfill,
  preparePhotos,
} from './legacy-backfill';
import type { LegacyEntry } from './legacy-our-team';
import { compressPhoto } from './photo-compression';

const ID = '11111111-1111-4111-8111-111111111111';
const CDN = 'https://cdn.shopify.com/s/files/1/0001';
const PUBLIC =
  'https://proj.supabase.co/storage/v1/object/public/instructor-public';

function image(url: string) {
  return {
    __typename: 'MediaImage',
    id: 'gid://1',
    alt: null,
    image: { url, width: 3000, height: 4000 },
  };
}

function entry(
  fields: Record<string, string | ReturnType<typeof image>>,
  translations: { key: string; value: string }[] = [],
): LegacyEntry {
  return {
    id: 'gid://shopify/Metaobject/1',
    handle: 'tiger',
    type: 'our_team',
    displayName: null,
    createdAt: '',
    updatedAt: '',
    publishableStatus: 'ACTIVE',
    fields: Object.entries(fields).map(([key, value]) =>
      typeof value === 'string'
        ? {
            key,
            type: 'single_line_text_field',
            value,
            jsonValue: value,
            reference: null,
          }
        : {
            key,
            type: 'file_reference',
            value: 'gid://1',
            jsonValue: 'gid://1',
            reference: value,
          },
    ),
    translatableContent: [],
    translations: translations.map((t) => ({
      ...t,
      locale: 'en',
      outdated: false,
      updatedAt: null,
    })),
  };
}

function instructor(
  overrides: Partial<BackfillInstructor> = {},
): BackfillInstructor {
  return {
    id: ID,
    display_name_en: 'Tiger',
    display_name_zh: null,
    bio_en: 'I wrote this myself',
    bio_zh: null,
    display_order: null,
    profile_photo_url: `${PUBLIC}/${ID}/avatar.png`,
    photo_2_url: null,
    photo_3_url: null,
    ...overrides,
  };
}

describe('parseLegacyTrainer', () => {
  it('reads a course conductor level as the trainer level for the cert organisation', () => {
    expect(
      parseLegacyTrainer('CSIA Level 3 | Course Conductor Level 1 | Trainer'),
    ).toEqual({
      discipline: 'ski',
      level: 1,
      notes: [],
    });
  });

  it('treats a bare Trainer as level 1', () => {
    expect(parseLegacyTrainer('CASI Level 3｜Trainer')).toMatchObject({
      discipline: 'snowboard',
      level: 1,
    });
  });

  it('reports trainer credentials it cannot map', () => {
    const parsed = parseLegacyTrainer('CSIA Level 4 | Ski Technical Trainer B');
    expect(parsed.level).toBeNull();
    expect(parsed.notes).toEqual([
      'unmapped trainer credential "Ski Technical Trainer B"',
    ]);
  });

  it('refuses to guess the discipline when both organisations appear', () => {
    const parsed = parseLegacyTrainer(
      'CSIA Level 3 | CASI Level 2 | Course Conductor Level 1',
    );
    expect(parsed.level).toBeNull();
    expect(parsed.notes[0]).toMatch(/ambiguous/);
  });

  it('finds no trainer level in a plain certification', () => {
    expect(parseLegacyTrainer('CSIA Level 2')).toEqual({
      discipline: null,
      level: null,
      notes: [],
    });
  });
});

describe('isMeaningfulBio', () => {
  it.each(['tba', ' TBA ', '', '暂无'])(
    'treats %p as a placeholder',
    (value) => {
      expect(isMeaningfulBio(value)).toBe(false);
    },
  );

  it('accepts real text', () => {
    expect(isMeaningfulBio('爱滑雪的程序员')).toBe(true);
  });
});

describe('planInstructorBackfill', () => {
  it('replaces photos and the Chinese bio, and queues an English translation', () => {
    const plan = planInstructorBackfill(
      entry({
        name: 'Tiger',
        introduction: '爱滑雪的程序员',
        picture: image(`${CDN}/a.png?v=1`),
        image_2: image(`${CDN}/c.jpg`),
        sort_order: '1',
        certification: 'CSIA Level 3',
      }),
      instructor({ bio_zh: '旧的', display_order: 5 }),
      [],
    );
    expect(
      plan.photos.map((p) => [p.slot.field, p.sourceUrl, p.objectPath]),
    ).toEqual([
      ['picture', `${CDN}/a.png`, `${ID}/avatar.jpg`],
      ['image_2', `${CDN}/c.jpg`, `${ID}/photo-3.jpg`],
    ]);
    expect(plan.update).toMatchObject({
      bio_zh: '爱滑雪的程序员',
      bio_en: null,
      bio_en_machine_translated: false,
      display_order: 1,
    });
    expect(plan.update).not.toHaveProperty('display_name_zh');
    expect(plan.translateBioToEn).toBe('爱滑雪的程序员');
    expect(plan.trainer).toBeNull();
  });

  it('uses a legacy English bio instead of translating', () => {
    const plan = planInstructorBackfill(
      entry({ name: 'Tiger', introduction: '中文' }, [
        { key: 'introduction', value: 'English' },
      ]),
      instructor(),
      [],
    );
    expect(plan.update).toMatchObject({ bio_zh: '中文', bio_en: 'English' });
    expect(plan.translateBioToEn).toBeNull();
  });

  it('leaves bios alone when the legacy bio is a placeholder', () => {
    const plan = planInstructorBackfill(
      entry({ name: 'Tom', introduction: 'tba' }),
      instructor(),
      [],
    );
    expect(plan.update).not.toHaveProperty('bio_zh');
    expect(plan.update).not.toHaveProperty('bio_en');
    expect(plan.translateBioToEn).toBeNull();
  });

  it('copies a Chinese legacy name into the Chinese display name', () => {
    const plan = planInstructorBackfill(
      entry({ name: '茶壶 Jack' }),
      instructor(),
      [],
    );
    expect(plan.update.display_name_zh).toBe('茶壶 Jack');
  });

  it('adds a trainer level but never lowers an existing one', () => {
    const legacy = entry({
      name: 'Cosmo',
      certification: 'CSIA Level 3 | Course Conductor Level 1 | Trainer',
    });
    expect(planInstructorBackfill(legacy, instructor(), []).trainer).toEqual({
      discipline: 'ski',
      level: 1,
    });
    expect(
      planInstructorBackfill(legacy, instructor(), [
        { discipline: 'ski', trainer_level: 2 },
      ]).trainer,
    ).toBeNull();
  });
});

describe('compressPhoto', () => {
  it('fits the photo within 2000 px and re-encodes it as JPEG on a white background', async () => {
    const png = await sharp({
      create: {
        width: 3000,
        height: 4000,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const result = await compressPhoto(png);
    const meta = await sharp(result.bytes).metadata();
    expect(result.contentType).toBe('image/jpeg');
    expect([meta.format, meta.width, meta.height]).toEqual([
      'jpeg',
      1500,
      2000,
    ]);
    const { data } = await sharp(result.bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(Math.min(...data.subarray(0, 3))).toBeGreaterThan(250);
  });

  it('does not enlarge a small photo', async () => {
    const jpeg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#336699' },
    })
      .jpeg()
      .toBuffer();
    expect(await compressPhoto(jpeg)).toMatchObject({
      width: 800,
      height: 600,
    });
  });
});

interface Call {
  op: string;
  table?: string;
  args: unknown[];
}

function recordingSupabase(calls: Call[]): SupabaseClient {
  const chain = (table: string, op: string, args: unknown[]) => {
    calls.push({ op, table, args });
    const result = { data: null, error: null };
    const builder: Record<string, unknown> = {
      eq: () => builder,
      in: () => builder,
      maybeSingle: () => Promise.resolve(result),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(result).then(resolve),
    };
    return builder;
  };
  return {
    from: (table: string) => ({
      update: (...args: unknown[]) => chain(table, 'update', args),
      insert: (...args: unknown[]) => chain(table, 'insert', args),
      delete: (...args: unknown[]) => chain(table, 'delete', args),
      select: (...args: unknown[]) => chain(table, 'select', args),
    }),
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => {
          calls.push({ op: 'upload', args });
          return Promise.resolve({ error: null });
        },
        remove: (...args: unknown[]) => {
          calls.push({ op: 'remove', args });
          return Promise.resolve({ error: null });
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `${PUBLIC}/${path}` },
        }),
      }),
    },
  } as unknown as SupabaseClient;
}

describe('applyInstructorBackfill', () => {
  it('stores the compressed photo, updates the profile, queues the translation and records the run', async () => {
    const calls: Call[] = [];
    const io = {
      supabase: recordingSupabase(calls),
      bucket: 'instructor-public',
      fetchBytes: () => Promise.resolve(Buffer.alloc(3_000_000)),
      compress: () =>
        Promise.resolve({
          bytes: Buffer.alloc(200_000),
          contentType: 'image/jpeg' as const,
          width: 1500,
          height: 2000,
        }),
      log: () => undefined,
    };
    const current = instructor();
    const plan = planInstructorBackfill(
      entry({
        name: 'Cosmo',
        introduction: '你好',
        picture: image(`${CDN}/a.png`),
        certification: 'CSIA Level 3 | Course Conductor Level 1',
      }),
      current,
      [],
    );
    const photos = await preparePhotos(io, plan);
    await applyInstructorBackfill(
      io,
      plan,
      current,
      photos,
      new Date('2026-10-14T00:00:00Z'),
    );

    const upload = calls.find((c) => c.op === 'upload')!;
    expect(upload.args[0]).toBe(`${ID}/avatar.jpg`);
    expect((upload.args[1] as Buffer).length).toBe(200_000);

    const profile = calls.find(
      (c) => c.table === 'instructors' && c.op === 'update',
    )!;
    expect(profile.args[0]).toMatchObject({
      profile_photo_url: `${PUBLIC}/${ID}/avatar.jpg`,
      profile_photo_version: '2026-10-14T00:00:00.000Z',
      bio_zh: '你好',
      bio_en: null,
    });

    expect(calls.find((c) => c.op === 'remove')!.args[0]).toEqual([
      `${ID}/avatar.png`,
    ]);
    expect(
      calls.find(
        (c) => c.table === 'instructor_trainer_status' && c.op === 'insert',
      )!.args[0],
    ).toMatchObject({
      discipline: 'ski',
      trainer_level: 1,
      rookie_session_completed: false,
      trainer_exam_passed: false,
    });
    expect(
      calls.find(
        (c) => c.table === 'bio_translation_jobs' && c.op === 'insert',
      )!.args[0],
    ).toMatchObject({
      source_lang: 'zh-CN',
      target_lang: 'en',
      source_text: '你好',
    });
    expect(calls.find((c) => c.table === 'audit_log')!.args[0]).toMatchObject({
      action: BACKFILL_AUDIT_ACTION,
      target_id: ID,
    });
  });

  it('refuses a photo still over 5 MB after compression', async () => {
    const io = {
      supabase: recordingSupabase([]),
      bucket: 'instructor-public',
      fetchBytes: () => Promise.resolve(Buffer.alloc(10)),
      compress: () =>
        Promise.resolve({
          bytes: Buffer.alloc(6 * 1024 * 1024),
          contentType: 'image/jpeg' as const,
          width: 1,
          height: 1,
        }),
      log: () => undefined,
    };
    const plan = planInstructorBackfill(
      entry({ name: 'X', picture: image(`${CDN}/a.png`) }),
      instructor(),
      [],
    );
    await expect(preparePhotos(io, plan)).rejects.toThrow(
      /over the 5242880 byte limit/,
    );
  });
});
