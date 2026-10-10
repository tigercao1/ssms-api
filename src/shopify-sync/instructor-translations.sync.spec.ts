import {
  FakeShopify,
  INSTRUCTOR_ID,
  InMemorySyncRepository,
  snapshotOf,
} from '../../test/helpers/shopify-sync-fakes';
import { englishTranslations } from './instructor-fields.builder';
import { InstructorPhotoSync } from './instructor-photo.sync';
import { InstructorSyncService } from './instructor-sync.service';
import type { SyncInstructorRow } from './instructor-sync.types';
import { InstructorTranslationsSync } from './instructor-translations.sync';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';

function setup() {
  const repo = new InMemorySyncRepository();
  const shopify = new FakeShopify();
  const gateway = new ShopifyInstructorGateway(shopify.client);
  const service = new InstructorSyncService(
    repo,
    gateway,
    new InstructorPhotoSync(repo, gateway, { sleep: () => Promise.resolve() }),
    new InstructorTranslationsSync(gateway),
  );
  const syncWith = (instructor: Partial<SyncInstructorRow>) => {
    repo.snapshots.set(INSTRUCTOR_ID, snapshotOf({ instructor }));
    return service.sync(INSTRUCTOR_ID);
  };
  return { shopify, syncWith, gateway };
}

const translationOps = (shopify: FakeShopify) =>
  shopify
    .operations()
    .filter(
      (op) =>
        op === 'SsmsTranslationsRegister' || op === 'SsmsTranslationsRemove',
    );

describe('English translations', () => {
  it('registers en name and introduction when the base values are Chinese', async () => {
    const { shopify, syncWith } = setup();
    await syncWith({});

    expect(shopify.translationsFor('eddie-chen')).toEqual({
      name: 'Eddie Chen',
      introduction: 'Loves powder.',
    });
    const register = shopify.calls.find(
      (c) => c.operation === 'SsmsTranslationsRegister',
    );
    expect(register?.variables.translations).toEqual([
      {
        key: 'name',
        value: 'Eddie Chen',
        locale: 'en',
        translatableContentDigest: 'digest:陈艾迪',
      },
      {
        key: 'introduction',
        value: 'Loves powder.',
        locale: 'en',
        translatableContentDigest: 'digest:热爱粉雪。',
      },
    ]);
  });

  it('does not re-register unchanged translations', async () => {
    const { shopify, syncWith } = setup();
    await syncWith({});
    await syncWith({});
    expect(translationOps(shopify)).toEqual(['SsmsTranslationsRegister']);
  });

  it('re-registers when the Chinese base changed and the translation is outdated', async () => {
    const { shopify, syncWith } = setup();
    await syncWith({});
    await syncWith({ bio_zh: '更爱树林。' });
    const last = shopify.calls.filter(
      (c) => c.operation === 'SsmsTranslationsRegister',
    )[1];
    expect(last?.variables.translations).toEqual([
      {
        key: 'introduction',
        value: 'Loves powder.',
        locale: 'en',
        translatableContentDigest: 'digest:更爱树林。',
      },
    ]);
  });

  it('removes the en translation when the base already is the English text', async () => {
    const { shopify, syncWith } = setup();
    await syncWith({});
    await syncWith({ display_name_zh: null });

    expect(shopify.entry('eddie-chen')?.fields.name).toBe('Eddie Chen');
    expect(shopify.translationsFor('eddie-chen')).toEqual({
      introduction: 'Loves powder.',
    });
    const remove = shopify.calls.find(
      (c) => c.operation === 'SsmsTranslationsRemove',
    );
    expect(remove?.variables).toMatchObject({
      translationKeys: ['name'],
      locales: ['en'],
    });
  });

  it('removes the en translation when English is blank so /en/ falls back to Chinese', async () => {
    const { shopify, syncWith } = setup();
    await syncWith({});
    await syncWith({ bio_en: '   ' });
    expect(shopify.translationsFor('eddie-chen')).toEqual({
      name: 'Eddie Chen',
    });
  });

  it('makes no translation calls when nothing should be registered or removed', async () => {
    const { shopify, syncWith } = setup();
    await syncWith({ display_name_zh: null, bio_zh: null, bio_en: null });
    expect(translationOps(shopify)).toEqual([]);
    expect(shopify.operations()).toContain('SsmsInstructorTranslations');
  });

  it('fails when the metaobject is not translatable', async () => {
    const { shopify, gateway } = setup();
    const sync = new InstructorTranslationsSync(gateway);
    await expect(
      sync.apply('gid://shopify/Metaobject/404', {
        name: 'x',
        introduction: null,
        client_groups: null,
        locations: null,
        languages: null,
      }),
    ).rejects.toThrow('is not translatable');
    expect(translationOps(shopify)).toEqual([]);
  });

  it('surfaces translation user errors', async () => {
    const { shopify, syncWith } = setup();
    shopify.failNext('SsmsTranslationsRegister', [
      { field: ['translations'], message: 'digest mismatch', code: 'INVALID' },
    ]);
    await expect(syncWith({})).rejects.toThrow('digest mismatch');
  });
});

describe('englishTranslations', () => {
  const noRefs = { client_groups: null, locations: null, languages: null };

  it.each([
    [{}, { name: 'Eddie Chen', introduction: 'Loves powder.', ...noRefs }],
    [
      { display_name_zh: ' ', bio_zh: null },
      { name: null, introduction: null, ...noRefs },
    ],
    [
      { display_name_en: '', bio_en: null },
      { name: null, introduction: null, ...noRefs },
    ],
  ])('%j → %j', (overrides, expected) => {
    expect(englishTranslations(snapshotOf({ instructor: overrides }))).toEqual(
      expected,
    );
  });

  it('translates reference lists only when a Chinese name changes the base', () => {
    const translations = englishTranslations(
      snapshotOf({
        locations: [
          { name: 'Whistler', name_zh: '惠斯勒' },
          { name: 'Banff', name_zh: null },
        ],
        languages: [{ name: 'English', name_zh: null }],
        courseLevels: [{ name: 'Beginner', name_zh: '新手' }],
        examPreparations: [{ name: 'CSIA Level 1 prep', name_zh: null }],
      }),
    );

    expect(translations).toMatchObject({
      client_groups: 'Beginner, CSIA Level 1 prep',
      locations: '["Whistler","Banff"]',
      languages: null,
    });
  });
});

describe('English reference translations', () => {
  it('registers and later removes en locations, languages and client groups', async () => {
    const { shopify, gateway } = setup();
    const repo = new InMemorySyncRepository();
    const service = new InstructorSyncService(
      repo,
      gateway,
      new InstructorPhotoSync(repo, gateway, {
        sleep: () => Promise.resolve(),
      }),
      new InstructorTranslationsSync(gateway),
    );
    const withNames = snapshotOf({
      locations: [{ name: 'Whistler', name_zh: '惠斯勒' }],
      languages: [{ name: 'Mandarin', name_zh: '普通话' }],
      courseLevels: [{ name: 'Beginner', name_zh: '新手' }],
    });
    repo.snapshots.set(INSTRUCTOR_ID, withNames);
    await service.sync(INSTRUCTOR_ID);

    expect(shopify.entry('eddie-chen')?.fields).toMatchObject({
      locations: '["惠斯勒"]',
      languages: '["普通话"]',
      client_groups: '新手',
    });
    expect(shopify.translationsFor('eddie-chen')).toEqual({
      name: 'Eddie Chen',
      introduction: 'Loves powder.',
      client_groups: 'Beginner',
      locations: '["Whistler"]',
      languages: '["Mandarin"]',
    });

    repo.snapshots.set(
      INSTRUCTOR_ID,
      snapshotOf({
        locations: [{ name: 'Whistler', name_zh: null }],
        languages: [{ name: 'Mandarin', name_zh: '普通话' }],
      }),
    );
    await service.sync(INSTRUCTOR_ID);

    expect(shopify.translationsFor('eddie-chen')).toEqual({
      name: 'Eddie Chen',
      introduction: 'Loves powder.',
      languages: '["Mandarin"]',
    });
  });
});
