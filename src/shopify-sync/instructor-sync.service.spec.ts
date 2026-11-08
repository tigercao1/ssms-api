import {
  FakeShopify,
  goLiveFor,
  INSTRUCTOR_ID,
  InMemorySyncRepository,
  readySnapshotOf,
  readyWhenVisible,
  snapshotOf,
  verifiedUpload,
} from '../../test/helpers/shopify-sync-fakes';
import { InstructorPhotoSync } from './instructor-photo.sync';
import { InstructorSyncService } from './instructor-sync.service';
import { InstructorTranslationsSync } from './instructor-translations.sync';
import type { InstructorSnapshot } from './instructor-sync.types';
import { LegacyRoster, LegacyRosterUnavailableError } from './legacy-roster';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';
import { ShopifyUserErrorsError } from '../shopify/shopify.errors';

const OTHER_ID = '9b8a7c6d-0000-4000-8000-000000000001';

function lastUpdate(shopify: FakeShopify) {
  return shopify.calls
    .filter((c) => c.operation === 'SsmsInstructorUpdate')
    .at(-1)?.variables.metaobject as {
    handle?: string;
    redirectNewHandle?: boolean;
    fields: { key: string }[];
  };
}

function setupGoLive(snapshot: InstructorSnapshot = readySnapshotOf()) {
  const repo = new InMemorySyncRepository();
  repo.snapshots.set(snapshot.instructor.id, snapshot);
  const shopify = new FakeShopify();
  const gateway = new ShopifyInstructorGateway(shopify.client);
  const legacy = new LegacyRoster(gateway, repo);
  const goLive = goLiveFor(repo, {}, legacy);
  goLive.subjects.uploads.push(verifiedUpload('csia', 'regular', 3));
  const service = new InstructorSyncService(
    repo,
    gateway,
    new InstructorPhotoSync(repo, gateway, { sleep: () => Promise.resolve() }),
    new InstructorTranslationsSync(gateway),
    goLive.service,
    legacy,
  );
  const { subjects, templates, assignments } = goLive;
  return {
    repo,
    shopify,
    service,
    subjects,
    templates,
    assignments,
    goLive: goLive.service,
  };
}

function setup(snapshot: InstructorSnapshot | null = snapshotOf()) {
  const repo = new InMemorySyncRepository();
  if (snapshot) {
    repo.snapshots.set(snapshot.instructor.id, snapshot);
  }
  const shopify = new FakeShopify();
  const gateway = new ShopifyInstructorGateway(shopify.client);
  const service = new InstructorSyncService(
    repo,
    gateway,
    new InstructorPhotoSync(repo, gateway, { sleep: () => Promise.resolve() }),
    new InstructorTranslationsSync(gateway),
    readyWhenVisible(repo),
    new LegacyRoster(gateway, repo),
  );
  return { repo, shopify, service };
}

describe('InstructorSyncService', () => {
  describe('visible instructor', () => {
    it('creates an ACTIVE entry under a slug of the English name and stores the link', async () => {
      const { repo, shopify, service } = setup();

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');

      const entry = shopify.entry('eddie-chen');
      expect(entry?.status).toBe('ACTIVE');
      expect(entry?.fields).toMatchObject({
        name: '陈艾迪',
        ssms_id: INSTRUCTOR_ID,
      });
      expect(repo.states.get(INSTRUCTOR_ID)).toMatchObject({
        shopify_handle: 'eddie-chen',
        shopify_metaobject_id: entry?.id,
        last_status: 'active',
      });
    });

    it('sends field inputs only, never a values replacement', async () => {
      const { shopify, service } = setup();
      await service.sync(INSTRUCTOR_ID);

      const upsert = shopify.calls.find(
        (c) => c.operation === 'SsmsInstructorUpsert',
      );
      expect(upsert?.variables).not.toHaveProperty('values');
      expect(upsert?.variables).toMatchObject({
        handle: { type: 'ssms_instructor', handle: 'eddie-chen' },
        metaobject: { capabilities: { publishable: { status: 'ACTIVE' } } },
      });
      expect(
        (upsert?.variables.metaobject as { fields: unknown[] }).fields.length,
      ).toBeGreaterThan(0);
      const [query] = shopify.client.graphql.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(query).not.toContain('our_team');
    });

    it('adds 4, then 6 hex of its own id when the handle is taken in Shopify or stored for someone else', async () => {
      const { repo, shopify, service } = setup();
      shopify.addEntry('eddie-chen', { ssms_id: OTHER_ID });
      await repo.saveState(OTHER_ID, { shopify_handle: 'eddie-chen-3f1c' });

      await service.sync(INSTRUCTOR_ID);

      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe(
        'eddie-chen-3f1c2b',
      );
      expect(shopify.entry('eddie-chen-3f1c2b')?.fields.ssms_id).toBe(
        INSTRUCTOR_ID,
      );
      expect(shopify.entry('eddie-chen')?.fields.ssms_id).toBe(OTHER_ID);
    });

    it('uses 8 hex of its own id when the 4 and 6 hex handles are taken too', async () => {
      const { repo, shopify, service } = setup();
      shopify.addEntry('eddie-chen', { ssms_id: OTHER_ID });
      shopify.addEntry('eddie-chen-3f1c', { ssms_id: OTHER_ID });
      shopify.addLegacyEntry('eddie-chen-3f1c2b', 'Someone Else');

      await service.sync(INSTRUCTOR_ID);

      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe(
        'eddie-chen-3f1c2b7a',
      );
    });

    it('treats an entry without an SSMS id as taken', async () => {
      const { repo, shopify, service } = setup();
      shopify.addEntry('eddie-chen');
      await service.sync(INSTRUCTOR_ID);
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe(
        'eddie-chen-3f1c',
      );
    });

    it('reclaims an entry that already carries its own SSMS id', async () => {
      const { repo, shopify, service } = setup();
      const own = shopify.addEntry('eddie-chen', { ssms_id: INSTRUCTOR_ID });
      await service.sync(INSTRUCTOR_ID);
      expect(repo.states.get(INSTRUCTOR_ID)).toMatchObject({
        shopify_handle: 'eddie-chen',
        shopify_metaobject_id: own.id,
      });
    });

    it('falls back to instructor-<uuid prefix> when no name slugifies', async () => {
      const { repo, service } = setup(
        snapshotOf({
          instructor: { display_name_en: '小李', display_name_zh: null },
        }),
      );
      await service.sync(INSTRUCTOR_ID);
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe(
        'instructor-3f1c2b7a',
      );
    });

    it('gives up when every candidate handle is taken', async () => {
      const { repo, service } = setup();
      const checked: string[] = [];
      repo.isHandleStoredByOther = (handle) => {
        checked.push(handle);
        return Promise.resolve(true);
      };
      await expect(service.sync(INSTRUCTOR_ID)).rejects.toThrow(
        'No free handle',
      );
      expect(checked).toEqual([
        'eddie-chen',
        'eddie-chen-3f1c',
        'eddie-chen-3f1c2b',
        'eddie-chen-3f1c2b7a',
      ]);
    });

    it('uses a stored (paired) handle as-is and never renames it', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({ instructor: { display_name_en: 'Edward' } }),
      );
      await repo.saveState(INSTRUCTOR_ID, { shopify_handle: 'eddie' });

      await service.sync(INSTRUCTOR_ID);
      await service.sync(INSTRUCTOR_ID);

      expect(shopify.entry('eddie')?.status).toBe('ACTIVE');
      expect(shopify.entry('edward')).toBeUndefined();
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('eddie');
      expect(
        shopify.operations().filter((op) => op.startsWith('SsmsInstructor')),
      ).toEqual([
        'SsmsInstructorEntries',
        'SsmsInstructorByHandle',
        'SsmsInstructorUpsert',
        'SsmsInstructorTranslations',
        'SsmsInstructorById',
        'SsmsInstructorUpdate',
        'SsmsInstructorTranslations',
      ]);
    });

    it('refuses to overwrite another instructor through a stored handle', async () => {
      const { repo, shopify, service } = setup();
      shopify.addEntry('eddie', { ssms_id: OTHER_ID, name: 'Other' });
      await repo.saveState(INSTRUCTOR_ID, { shopify_handle: 'eddie' });

      await expect(service.sync(INSTRUCTOR_ID)).rejects.toThrow(OTHER_ID);
      expect(shopify.entry('eddie')?.fields.name).toBe('Other');
    });

    it('refuses to overwrite a non-SSMS entry through a stored handle', async () => {
      const { repo, shopify, service } = setup();
      shopify.addEntry('eddie');
      await repo.saveState(INSTRUCTOR_ID, { shopify_handle: 'eddie' });
      await expect(service.sync(INSTRUCTOR_ID)).rejects.toThrow(
        'another entry',
      );
    });

    it('clears blank fields once the entry exists', async () => {
      const { repo, shopify, service } = setup();
      await service.sync(INSTRUCTOR_ID);
      repo.snapshots.set(
        INSTRUCTOR_ID,
        snapshotOf({ instructor: { bio_en: null, bio_zh: null } }),
      );
      await service.sync(INSTRUCTOR_ID);
      expect(shopify.entry('eddie-chen')?.fields.introduction).toBe('');
    });

    it('surfaces Shopify user errors and stores nothing', async () => {
      const { repo, shopify, service } = setup();
      shopify.failNext('SsmsInstructorUpsert', [
        { field: ['name'], message: 'is blank', code: 'BLANK' },
      ]);
      await expect(service.sync(INSTRUCTOR_ID)).rejects.toBeInstanceOf(
        ShopifyUserErrorsError,
      );
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_metaobject_id).toBeNull();
    });
  });

  describe('existing entry', () => {
    const ssmsEntries = (shopify: FakeShopify) =>
      [...shopify.entries.values()].filter((e) => e.type === 'ssms_instructor');

    it('follows an entry renamed in Shopify and adopts its handle without creating another', async () => {
      const { repo, shopify, service } = setup();
      await service.sync(INSTRUCTOR_ID);
      const created = shopify.renameEntry('eddie-chen', 'eddie');
      repo.snapshots.set(
        INSTRUCTOR_ID,
        snapshotOf({ instructor: { bio_zh: '新简介' } }),
      );

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');

      expect(ssmsEntries(shopify)).toHaveLength(1);
      expect(shopify.entry('eddie')?.fields.introduction).toBe('新简介');
      expect(repo.states.get(INSTRUCTOR_ID)).toMatchObject({
        shopify_handle: 'eddie',
        shopify_metaobject_id: created.id,
      });
      expect(lastUpdate(shopify)).not.toHaveProperty('handle');
    });

    it('never sends sort_order to an existing entry', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({ instructor: { display_order: 5 } }),
      );
      await service.sync(INSTRUCTOR_ID);
      expect(shopify.entry('eddie-chen')?.fields.sort_order).toBe('5');
      shopify.entry('eddie-chen')!.fields.sort_order = '11';

      repo.snapshots.set(
        INSTRUCTOR_ID,
        snapshotOf({ instructor: { display_order: null } }),
      );
      await service.sync(INSTRUCTOR_ID);
      repo.snapshots.set(
        INSTRUCTOR_ID,
        snapshotOf({ instructor: { display_order: 3 } }),
      );
      await service.sync(INSTRUCTOR_ID);

      expect(shopify.entry('eddie-chen')?.fields.sort_order).toBe('11');
      expect(lastUpdate(shopify).fields.map((f) => f.key)).not.toContain(
        'sort_order',
      );
    });

    it('adopts an unlinked entry that already carries its SSMS id', async () => {
      const { repo, shopify, service } = setup();
      const own = shopify.addEntry('eddie', {
        ssms_id: INSTRUCTOR_ID,
        sort_order: '7',
      });

      await service.sync(INSTRUCTOR_ID);

      expect(ssmsEntries(shopify)).toHaveLength(1);
      expect(shopify.entry('eddie')?.fields).toMatchObject({
        name: '陈艾迪',
        sort_order: '7',
      });
      expect(repo.states.get(INSTRUCTOR_ID)).toMatchObject({
        shopify_handle: 'eddie',
        shopify_metaobject_id: own.id,
      });
    });

    it('creates the entry again under the stored handle once the linked one is deleted', async () => {
      const { repo, shopify, service } = setup();
      await service.sync(INSTRUCTOR_ID);
      const oldId = shopify.entry('eddie-chen')?.id;
      shopify.removeEntry('eddie-chen');

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');

      const recreated = shopify.entry('eddie-chen');
      expect(recreated?.id).not.toBe(oldId);
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_metaobject_id).toBe(
        recreated?.id,
      );
    });

    it('refuses to write through a stored id that belongs to another instructor', async () => {
      const { repo, shopify, service } = setup();
      const other = shopify.addEntry('other', { ssms_id: OTHER_ID });
      await repo.saveState(INSTRUCTOR_ID, {
        shopify_handle: 'eddie-chen',
        shopify_metaobject_id: other.id,
      });

      await expect(service.sync(INSTRUCTOR_ID)).rejects.toThrow(OTHER_ID);
      expect(shopify.entry('eddie-chen')).toBeUndefined();
    });

    it('sets the renamed entry to DRAFT when the instructor is hidden', async () => {
      const { repo, shopify, service } = setup();
      await service.sync(INSTRUCTOR_ID);
      shopify.renameEntry('eddie-chen', 'eddie');
      repo.snapshots.set(
        INSTRUCTOR_ID,
        snapshotOf({ instructor: { is_active: false } }),
      );

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('draft');

      expect(shopify.entry('eddie')?.status).toBe('DRAFT');
      expect(shopify.entry('eddie-chen')).toBeUndefined();
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('eddie');
    });
  });

  describe('handle fallback', () => {
    const chineseOnly = { display_name_en: '乐乐', display_name_zh: null };

    it('uses the legal first name when the English display name has no Latin characters', async () => {
      const { repo, service } = setup(
        snapshotOf({
          instructor: {
            display_name_en: '囧泥',
            display_name_zh: null,
            first_name: 'Yuhan',
          },
        }),
      );
      await service.sync(INSTRUCTOR_ID);
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('yuhan');
    });

    it('goes from the legal first name straight to the uuid prefix, ignoring the Chinese display name', async () => {
      const { repo, service } = setup(
        snapshotOf({
          instructor: {
            display_name_en: '乐乐',
            display_name_zh: '乐乐',
            first_name: '可平',
          },
        }),
      );
      await service.sync(INSTRUCTOR_ID);
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe(
        'instructor-3f1c2b7a',
      );
    });

    it('adds hex of its own id to a taken legal first name', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({
          instructor: { display_name_en: '囧泥', first_name: 'Yuhan' },
        }),
      );
      shopify.addEntry('yuhan', { ssms_id: OTHER_ID });
      await service.sync(INSTRUCTOR_ID);
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('yuhan-3f1c');
    });

    it('adds hex of its own id to a taken uuid-prefix handle and still heals it later', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({ instructor: chineseOnly }),
      );
      await repo.saveState(OTHER_ID, { shopify_handle: 'instructor-3f1c2b7a' });
      await service.sync(INSTRUCTOR_ID);
      const entry = shopify.entry('instructor-3f1c2b7a-3f1c');
      expect(entry?.fields.ssms_id).toBe(INSTRUCTOR_ID);

      repo.snapshots.set(
        INSTRUCTOR_ID,
        snapshotOf({ instructor: { ...chineseOnly, display_name_en: 'Lele' } }),
      );
      await service.sync(INSTRUCTOR_ID);

      expect(shopify.entry('lele')?.id).toBe(entry?.id);
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('lele');
    });

    it('heals an old numbered uuid-prefix handle', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({ instructor: { ...chineseOnly, display_name_en: 'Lele' } }),
      );
      const old = shopify.addEntry('instructor-3f1c2b7a-2', {
        ssms_id: INSTRUCTOR_ID,
      });
      await repo.saveState(INSTRUCTOR_ID, {
        shopify_handle: 'instructor-3f1c2b7a-2',
        shopify_metaobject_id: old.id,
      });

      await service.sync(INSTRUCTOR_ID);

      expect(shopify.entry('lele')?.id).toBe(old.id);
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('lele');
    });

    it('renames a uuid-prefix handle once a better one exists, keeping the entry', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({ instructor: chineseOnly }),
      );
      await service.sync(INSTRUCTOR_ID);
      const entry = shopify.entry('instructor-3f1c2b7a');
      expect(entry).toBeDefined();

      repo.snapshots.set(
        INSTRUCTOR_ID,
        snapshotOf({
          instructor: { ...chineseOnly, display_name_en: 'Lele 乐乐' },
        }),
      );
      await service.sync(INSTRUCTOR_ID);

      expect(shopify.entry('instructor-3f1c2b7a')).toBeUndefined();
      expect(shopify.entry('lele')?.id).toBe(entry?.id);
      expect(lastUpdate(shopify)).toMatchObject({
        handle: 'lele',
        redirectNewHandle: true,
      });
      expect(repo.states.get(INSTRUCTOR_ID)).toMatchObject({
        shopify_handle: 'lele',
        shopify_metaobject_id: entry?.id,
      });
    });

    it('skips a better handle that someone else holds', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({ instructor: chineseOnly }),
      );
      await service.sync(INSTRUCTOR_ID);
      shopify.addEntry('lele', { ssms_id: OTHER_ID });

      repo.snapshots.set(
        INSTRUCTOR_ID,
        snapshotOf({ instructor: { ...chineseOnly, display_name_en: 'Lele' } }),
      );
      await service.sync(INSTRUCTOR_ID);

      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('lele-3f1c');
      expect(shopify.entry('lele')?.fields.ssms_id).toBe(OTHER_ID);
    });

    it('moves to its own entry that already holds the better handle and drafts the uuid-prefix one', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({ instructor: chineseOnly }),
      );
      await service.sync(INSTRUCTOR_ID);
      const renamed = shopify.addEntry('lele', {
        ssms_id: INSTRUCTOR_ID,
        sort_order: '11',
      });

      repo.snapshots.set(
        INSTRUCTOR_ID,
        snapshotOf({
          instructor: { ...chineseOnly, display_name_en: 'Lele 乐乐' },
        }),
      );
      await service.sync(INSTRUCTOR_ID);

      expect(shopify.entry('lele')).toMatchObject({
        status: 'ACTIVE',
        fields: { sort_order: '11', name: 'Lele 乐乐' },
      });
      expect(shopify.entry('instructor-3f1c2b7a')?.status).toBe('DRAFT');
      expect(repo.states.get(INSTRUCTOR_ID)).toMatchObject({
        shopify_handle: 'lele',
        shopify_metaobject_id: renamed.id,
      });
    });

    it('never renames a handle that is not a uuid-prefix fallback', async () => {
      const { repo, shopify, service } = setup();
      await service.sync(INSTRUCTOR_ID);
      repo.snapshots.set(
        INSTRUCTOR_ID,
        snapshotOf({ instructor: { display_name_en: 'Edward' } }),
      );

      await service.sync(INSTRUCTOR_ID);

      expect(shopify.entry('edward')).toBeUndefined();
      expect(shopify.entry('eddie-chen')?.fields.ssms_id).toBe(INSTRUCTOR_ID);
      expect(lastUpdate(shopify)).not.toHaveProperty('handle');
    });

    it('never renames an existing numbered handle', async () => {
      const { repo, shopify, service } = setup();
      const numbered = shopify.addEntry('eddie-chen-2', {
        ssms_id: INSTRUCTOR_ID,
      });
      await repo.saveState(INSTRUCTOR_ID, {
        shopify_handle: 'eddie-chen-2',
        shopify_metaobject_id: numbered.id,
      });

      await service.sync(INSTRUCTOR_ID);

      expect(shopify.entry('eddie-chen')).toBeUndefined();
      expect(shopify.entry('eddie-chen-2')?.status).toBe('ACTIVE');
      expect(lastUpdate(shopify)).not.toHaveProperty('handle');
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe(
        'eddie-chen-2',
      );
    });
  });

  describe('hidden or deleted instructor', () => {
    it.each([
      ['pending', { approval_status: 'pending' }],
      ['rejected', { approval_status: 'rejected' }],
      ['offline', { is_active: false }],
    ])('sets an existing entry to DRAFT when %s', async (_label, overrides) => {
      const { repo, shopify, service } = setup();
      await service.sync(INSTRUCTOR_ID);
      repo.snapshots.set(INSTRUCTOR_ID, snapshotOf({ instructor: overrides }));

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('draft');

      const entry = shopify.entry('eddie-chen');
      expect(entry?.status).toBe('DRAFT');
      expect(entry?.fields.name).toBe('陈艾迪');
      expect(repo.states.get(INSTRUCTOR_ID)?.last_status).toBe('draft');
    });

    it('sets the entry to DRAFT when the instructor was deleted, never deleting it', async () => {
      const { repo, shopify, service } = setup();
      await service.sync(INSTRUCTOR_ID);
      repo.snapshots.delete(INSTRUCTOR_ID);

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('draft');

      expect(shopify.entry('eddie-chen')?.status).toBe('DRAFT');
      expect(shopify.operations()).not.toContain('SsmsInstructorDelete');
    });

    it('does nothing when no entry was ever created', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({ instructor: { approval_status: 'pending' } }),
      );
      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('skipped');
      await expect(service.sync(OTHER_ID)).resolves.toBe('skipped');
      expect(shopify.calls).toHaveLength(0);
      expect(repo.states.size).toBe(0);
    });
  });

  describe('go-live gate', () => {
    it('publishes an instructor who is ready to go live', async () => {
      const { shopify, service } = setupGoLive();

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');

      expect(shopify.entry('eddie-chen')).toMatchObject({
        status: 'ACTIVE',
        fields: { type: '双板', certification: 'CSIA Level 3' },
      });
    });

    it('creates nothing for an approved instructor who is not ready', async () => {
      const { repo, shopify, service } = setupGoLive(
        readySnapshotOf({ languages: [] }),
      );

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('skipped');

      expect(shopify.calls).toHaveLength(0);
      expect(repo.states.size).toBe(0);
    });

    it('sets a live entry to DRAFT once a required document is outstanding', async () => {
      const { repo, shopify, service, templates, assignments } = setupGoLive();
      await service.sync(INSTRUCTOR_ID);
      const template = templates.seed({ status: 'live' });
      assignments.seed({ template_id: template.id, subject_id: INSTRUCTOR_ID });

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('draft');

      expect(shopify.entry('eddie-chen')?.status).toBe('DRAFT');
      expect(repo.states.get(INSTRUCTOR_ID)?.last_status).toBe('draft');
    });

    it('sets a live entry to DRAFT when its only proof expires', async () => {
      const { shopify, service, subjects } = setupGoLive();
      await service.sync(INSTRUCTOR_ID);
      subjects.uploads[0].valid_until = '2020-01-01';

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('draft');
      expect(shopify.entry('eddie-chen')?.status).toBe('DRAFT');
    });

    it('sends only verified certifications to Shopify', async () => {
      const { shopify, service, subjects } = setupGoLive(
        readySnapshotOf({
          certifications: [
            { org: 'csia', track: 'regular', level: 4, is_partial: false },
            { org: 'casi', track: 'regular', level: 2, is_partial: false },
          ],
          trainers: [{ discipline: 'ski', trainer_level: 1 }],
        }),
      );
      subjects.uploads.length = 0;
      subjects.uploads.push(verifiedUpload('casi', 'regular', 2));
      subjects.uploads.push(verifiedUpload('csia', 'regular', 3));

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');

      expect(shopify.entry('eddie-chen')?.fields).toMatchObject({
        type: '双板 | 单板',
        certification: 'Ski Trainer Level 1, CASI Level 2',
      });
    });
  });

  describe('legacy our_team guard', () => {
    const ssmsOps = (shopify: FakeShopify) =>
      shopify.operations().filter((op) => op.startsWith('SsmsInstructor'));

    it('never claims a legacy handle, drafts included, for an unpaired instructor', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({ instructor: { display_name_en: 'Aaron' } }),
      );
      shopify.addLegacyEntry('aaron', 'Aaron Wu', 'DRAFT');

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');

      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('aaron-3f1c');
      expect(shopify.entry('aaron-3f1c')?.status).toBe('ACTIVE');
      expect(shopify.entry('aaron')).toBeUndefined();
    });

    it('keeps adding id hex past legacy handles that already carry it', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({ instructor: { display_name_en: 'Aaron' } }),
      );
      shopify.addLegacyEntry('aaron', 'Aaron Wu');
      shopify.addLegacyEntry('aaron-3f1c', 'Aaron Li');

      await service.sync(INSTRUCTOR_ID);

      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe(
        'aaron-3f1c2b',
      );
    });

    it('keeps a paired legacy handle and syncs it exactly as before', async () => {
      const { repo, shopify, service } = setup(
        snapshotOf({ instructor: { display_name_en: 'Aaron' } }),
      );
      shopify.addLegacyEntry('aaron', 'Aaron');
      await repo.saveState(INSTRUCTOR_ID, { shopify_handle: 'aaron' });

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');

      expect(shopify.entry('aaron')?.status).toBe('ACTIVE');
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('aaron');
      expect(ssmsOps(shopify)).toEqual([
        'SsmsInstructorEntries',
        'SsmsInstructorByHandle',
        'SsmsInstructorUpsert',
        'SsmsInstructorTranslations',
      ]);
    });

    it('claims nothing and fails the run when the legacy list cannot be fetched', async () => {
      const { repo, shopify, service } = setup();
      shopify.legacyRosterError = new Error('Throttled');

      await expect(service.sync(INSTRUCTOR_ID)).rejects.toBeInstanceOf(
        LegacyRosterUnavailableError,
      );

      expect(repo.states.size).toBe(0);
      expect(ssmsOps(shopify)).toEqual([]);

      shopify.legacyRosterError = undefined;
      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('eddie-chen');
    });

    it('fetches the legacy list once per cache window', async () => {
      const { shopify, service } = setup();
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        await service.sync(INSTRUCTOR_ID);
        await service.sync(INSTRUCTOR_ID);
        now.mockReturnValue(1_000_000 + 5 * 60_000);
        await service.sync(INSTRUCTOR_ID);
      } finally {
        now.mockRestore();
      }
      expect(
        shopify.operations().filter((op) => op === 'SsmsLegacyRoster'),
      ).toHaveLength(2);
    });

    it('holds an unpaired exact name match as DRAFT and explains why', async () => {
      const { repo, shopify, service, goLive } = setupGoLive();
      shopify.addLegacyEntry('eddie', 'Eddie Chen');

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('held');

      expect(ssmsOps(shopify)).toEqual([]);
      expect(repo.states.size).toBe(0);
      await expect(goLive.status(INSTRUCTOR_ID)).resolves.toMatchObject({
        live: false,
        ready: true,
        hold: {
          reason: 'legacy_pairing_decision',
          legacyHandle: 'eddie',
          legacyName: 'Eddie Chen',
          message: 'needs legacy pairing decision: eddie',
        },
      });
    });

    it('sets a live unpaired entry back to DRAFT once a legacy entry matches its Chinese name', async () => {
      const { repo, shopify, service, goLive } = setupGoLive();
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        await service.sync(INSTRUCTOR_ID);
        shopify.addLegacyEntry('ai-di', '陈艾迪');
        now.mockReturnValue(1_000_000 + 5 * 60_000);

        await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('held');
      } finally {
        now.mockRestore();
      }

      expect(shopify.entry('eddie-chen')?.status).toBe('DRAFT');
      expect(repo.states.get(INSTRUCTOR_ID)?.last_status).toBe('draft');
      await expect(goLive.status(INSTRUCTOR_ID)).resolves.toMatchObject({
        live: false,
        hold: { legacyHandle: 'ai-di' },
      });
    });

    it('publishes once the match is dismissed as a different person', async () => {
      const { repo, shopify, service, goLive } = setupGoLive();
      shopify.addLegacyEntry('eddie', 'Eddie Chen');
      await service.sync(INSTRUCTOR_ID);
      await repo.saveState(INSTRUCTOR_ID, {
        dismissed_legacy_handles: ['eddie'],
      });

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');

      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('eddie-chen');
      expect(shopify.entry('eddie-chen')?.status).toBe('ACTIVE');
      await expect(goLive.status(INSTRUCTOR_ID)).resolves.toMatchObject({
        live: true,
        hold: null,
      });
    });

    it('does not hold for a legacy entry already paired with someone else', async () => {
      const { repo, shopify, service } = setupGoLive();
      shopify.addLegacyEntry('eddie', 'Eddie Chen');
      await repo.saveState(OTHER_ID, { shopify_handle: 'eddie' });

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe('eddie-chen');
    });

    it('does not hold for a near but inexact name', async () => {
      const { shopify, service } = setupGoLive();
      shopify.addLegacyEntry('eddie', 'Eddy Chen');

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');
    });

    it('never holds a paired instructor whose name also matches another legacy entry', async () => {
      const { repo, shopify, service, goLive } = setupGoLive();
      shopify.addLegacyEntry('eddie', 'Eddie');
      shopify.addLegacyEntry('eddie-chen-old', 'Eddie Chen');
      await repo.saveState(INSTRUCTOR_ID, { shopify_handle: 'eddie' });

      await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');

      expect(shopify.entry('eddie')?.status).toBe('ACTIVE');
      expect(ssmsOps(shopify)).toEqual([
        'SsmsInstructorEntries',
        'SsmsInstructorByHandle',
        'SsmsInstructorUpsert',
        'SsmsInstructorTranslations',
      ]);
      await expect(goLive.status(INSTRUCTOR_ID)).resolves.toMatchObject({
        hold: null,
      });
    });

    it('reports no hold rather than failing the status call when the legacy list is unavailable', async () => {
      const { shopify, goLive } = setupGoLive();
      shopify.legacyRosterError = new Error('Throttled');

      await expect(goLive.status(INSTRUCTOR_ID)).resolves.toMatchObject({
        ready: true,
        hold: null,
      });
    });
  });
});
