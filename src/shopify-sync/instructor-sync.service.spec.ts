import {
  FakeShopify,
  INSTRUCTOR_ID,
  InMemorySyncRepository,
  snapshotOf,
} from '../../test/helpers/shopify-sync-fakes';
import { InstructorPhotoSync } from './instructor-photo.sync';
import { InstructorSyncService } from './instructor-sync.service';
import { InstructorTranslationsSync } from './instructor-translations.sync';
import type { InstructorSnapshot } from './instructor-sync.types';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';
import { ShopifyUserErrorsError } from '../shopify/shopify.errors';

const OTHER_ID = '9b8a7c6d-0000-4000-8000-000000000001';

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

    it('adds -2, -3 when the handle is taken in Shopify or stored for someone else', async () => {
      const { repo, shopify, service } = setup();
      shopify.addEntry('eddie-chen', { ssms_id: OTHER_ID });
      await repo.saveState(OTHER_ID, { shopify_handle: 'eddie-chen-2' });

      await service.sync(INSTRUCTOR_ID);

      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe(
        'eddie-chen-3',
      );
      expect(shopify.entry('eddie-chen-3')?.fields.ssms_id).toBe(INSTRUCTOR_ID);
      expect(shopify.entry('eddie-chen')?.fields.ssms_id).toBe(OTHER_ID);
    });

    it('treats an entry without an SSMS id as taken', async () => {
      const { repo, shopify, service } = setup();
      shopify.addEntry('eddie-chen');
      await service.sync(INSTRUCTOR_ID);
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe(
        'eddie-chen-2',
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

    it('falls back to instructor-<uuid prefix> when the English name does not slugify', async () => {
      const { repo, service } = setup(
        snapshotOf({ instructor: { display_name_en: '小李' } }),
      );
      await service.sync(INSTRUCTOR_ID);
      expect(repo.states.get(INSTRUCTOR_ID)?.shopify_handle).toBe(
        'instructor-3f1c2b7a',
      );
    });

    it('gives up when every candidate handle is taken', async () => {
      const { repo, service } = setup();
      repo.isHandleStoredByOther = () => Promise.resolve(true);
      await expect(service.sync(INSTRUCTOR_ID)).rejects.toThrow(
        'No free handle',
      );
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
        'SsmsInstructorByHandle',
        'SsmsInstructorUpsert',
        'SsmsInstructorTranslations',
        'SsmsInstructorUpsert',
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
});
