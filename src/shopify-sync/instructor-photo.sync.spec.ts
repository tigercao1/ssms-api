import {
  FakeShopify,
  INSTRUCTOR_ID,
  InMemorySyncRepository,
  snapshotOf,
} from '../../test/helpers/shopify-sync-fakes';
import {
  InstructorPhotoSync,
  PHOTO_POLL_ATTEMPTS,
  PHOTO_POLL_INTERVAL_MS,
  storageObject,
} from './instructor-photo.sync';
import { InstructorSyncService } from './instructor-sync.service';
import { InstructorTranslationsSync } from './instructor-translations.sync';
import type { SyncInstructorRow } from './instructor-sync.types';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';

const PHOTO_URL = `https://abc.supabase.co/storage/v1/object/public/instructor-public/${INSTRUCTOR_ID}/avatar.jpg`;
const V1 = '2026-10-10T03:00:00.123456+00:00';
const V2 = '2026-10-11T08:30:00.5+00:00';
const V1_EPOCH = Date.parse(V1);
const V2_EPOCH = Date.parse(V2);

function setup(instructor: Partial<SyncInstructorRow> = {}) {
  const repo = new InMemorySyncRepository();
  const shopify = new FakeShopify();
  const sleeps: number[] = [];
  const gateway = new ShopifyInstructorGateway(shopify.client);
  const service = new InstructorSyncService(
    repo,
    gateway,
    new InstructorPhotoSync(repo, gateway, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }),
    new InstructorTranslationsSync(gateway),
  );
  const setInstructor = (overrides: Partial<SyncInstructorRow>) =>
    repo.snapshots.set(
      INSTRUCTOR_ID,
      snapshotOf({ instructor: { ...instructor, ...overrides } }),
    );
  setInstructor({});
  return { repo, shopify, service, sleeps, setInstructor };
}

const withPhoto = { profile_photo_url: PHOTO_URL, profile_photo_version: V1 };

describe('photo sync', () => {
  it('uploads from a short-lived signed URL, waits for READY and links the picture', async () => {
    const { repo, shopify, service, sleeps } = setup(withPhoto);

    await service.sync(INSTRUCTOR_ID);

    expect(repo.signedUrls).toEqual([
      {
        bucket: 'instructor-public',
        path: `${INSTRUCTOR_ID}/avatar.jpg`,
        expiresInSeconds: 600,
      },
    ]);
    const create = shopify.calls.find((c) => c.operation === 'SsmsPhotoCreate');
    expect(create?.variables.files).toEqual([
      {
        originalSource: `https://storage.test/instructor-public/${INSTRUCTOR_ID}/avatar.jpg?token=signed-1`,
        filename: `instructor-${INSTRUCTOR_ID}-${V1_EPOCH}.jpg`,
        contentType: 'IMAGE',
        duplicateResolutionMode: 'RAISE_ERROR',
      },
    ]);
    const file = shopify.fileNamed(
      `instructor-${INSTRUCTOR_ID}-${V1_EPOCH}.jpg`,
    );
    expect(shopify.entry('eddie-chen')?.fields.picture).toBe(file?.id);
    expect(repo.states.get(INSTRUCTOR_ID)).toMatchObject({
      shopify_photo_file_id: file?.id,
      synced_photo_version: V1,
    });
    expect(sleeps).toEqual([PHOTO_POLL_INTERVAL_MS, PHOTO_POLL_INTERVAL_MS]);
  });

  it('does not re-upload while the photo version is unchanged', async () => {
    const { repo, shopify, service } = setup(withPhoto);
    await service.sync(INSTRUCTOR_ID);
    const fileId = repo.states.get(INSTRUCTOR_ID)?.shopify_photo_file_id;

    await service.sync(INSTRUCTOR_ID);

    expect(
      shopify.operations().filter((op) => op === 'SsmsPhotoCreate'),
    ).toHaveLength(1);
    expect(repo.signedUrls).toHaveLength(1);
    expect(shopify.entry('eddie-chen')?.fields.picture).toBe(fileId);
  });

  it('uploads again when the version changes, then deletes the old file', async () => {
    const { repo, shopify, service, setInstructor } = setup(withPhoto);
    await service.sync(INSTRUCTOR_ID);
    const oldId = repo.states.get(INSTRUCTOR_ID)?.shopify_photo_file_id;

    setInstructor({ profile_photo_version: V2 });
    await service.sync(INSTRUCTOR_ID);

    const newFile = shopify.fileNamed(
      `instructor-${INSTRUCTOR_ID}-${V2_EPOCH}.jpg`,
    );
    expect(newFile).toBeDefined();
    expect(shopify.entry('eddie-chen')?.fields.picture).toBe(newFile?.id);
    expect(repo.states.get(INSTRUCTOR_ID)?.synced_photo_version).toBe(V2);
    expect(shopify.files.has(oldId as string)).toBe(false);
    const ops = shopify.operations();
    expect(ops.lastIndexOf('SsmsPhotoDelete')).toBeGreaterThan(
      ops.lastIndexOf('SsmsInstructorUpsert'),
    );
  });

  it('reuses an existing file with the same name instead of failing', async () => {
    const { repo, shopify, service } = setup(withPhoto);
    const existing = shopify.addFile(
      `instructor-${INSTRUCTOR_ID}-${V1_EPOCH}.jpg`,
    );

    await service.sync(INSTRUCTOR_ID);

    expect(shopify.files.size).toBe(1);
    expect(repo.states.get(INSTRUCTOR_ID)?.shopify_photo_file_id).toBe(
      existing.id,
    );
    expect(shopify.entry('eddie-chen')?.fields.picture).toBe(existing.id);
  });

  it('fails when a duplicate name is reported but the file cannot be found', async () => {
    const { shopify, service } = setup(withPhoto);
    shopify.addFile(`instructor-${INSTRUCTOR_ID}-${V1_EPOCH}.jpg`);
    shopify.on('SsmsPhotoByName', () => ({ files: { nodes: [] } }));
    await expect(service.sync(INSTRUCTOR_ID)).rejects.toThrow(
      'filename already exists',
    );
    expect(shopify.entry('eddie-chen')).toBeUndefined();
  });

  it('records a FAILED file as an error, deletes it and leaves the entry unwritten', async () => {
    const { repo, shopify, service } = setup(withPhoto);
    shopify.fileStatuses = ['UPLOADED', 'FAILED'];
    shopify.on('SsmsPhotoStatus', (v) => ({
      node: {
        id: v.id,
        fileStatus: 'FAILED',
        fileErrors: [{ code: 'DOWNLOAD_FAILURE', message: 'could not fetch' }],
      },
    }));

    await expect(service.sync(INSTRUCTOR_ID)).rejects.toThrow(
      'DOWNLOAD_FAILURE: could not fetch',
    );

    expect(shopify.files.size).toBe(0);
    expect(shopify.entry('eddie-chen')).toBeUndefined();
    expect(repo.states.get(INSTRUCTOR_ID)?.shopify_photo_file_id).toBeNull();
  });

  it('gives up after a bounded number of polls', async () => {
    const { shopify, service, sleeps } = setup(withPhoto);
    shopify.fileStatuses = ['PROCESSING'];

    await expect(service.sync(INSTRUCTOR_ID)).rejects.toThrow(
      `not ready after ${PHOTO_POLL_ATTEMPTS} checks`,
    );
    expect(sleeps).toHaveLength(PHOTO_POLL_ATTEMPTS);
  });

  it('fails when the file disappears while processing', async () => {
    const { shopify, service } = setup(withPhoto);
    shopify.on('SsmsPhotoStatus', () => ({ node: null }));
    await expect(service.sync(INSTRUCTOR_ID)).rejects.toThrow('disappeared');
  });

  it('clears the picture and deletes the file when the photo is removed', async () => {
    const { repo, shopify, service, setInstructor } = setup(withPhoto);
    await service.sync(INSTRUCTOR_ID);
    const oldId = repo.states.get(INSTRUCTOR_ID)?.shopify_photo_file_id;

    setInstructor({ profile_photo_url: null, profile_photo_version: V2 });
    await service.sync(INSTRUCTOR_ID);

    expect(shopify.entry('eddie-chen')?.fields.picture).toBe('');
    expect(shopify.files.has(oldId as string)).toBe(false);
    expect(repo.states.get(INSTRUCTOR_ID)).toMatchObject({
      shopify_photo_file_id: null,
      synced_photo_version: V2,
    });
  });

  it('keeps the sync successful when deleting the old file fails', async () => {
    const { repo, shopify, service, setInstructor } = setup(withPhoto);
    await service.sync(INSTRUCTOR_ID);
    setInstructor({ profile_photo_version: V2 });
    shopify.failNext('SsmsPhotoDelete', [
      { field: null, message: 'locked', code: 'FILE_LOCKED' },
    ]);

    await expect(service.sync(INSTRUCTOR_ID)).resolves.toBe('active');
    expect(repo.states.get(INSTRUCTOR_ID)?.synced_photo_version).toBe(V2);
  });

  it('never touches Shopify Files for an instructor without a photo', async () => {
    const { shopify, service } = setup();
    await service.sync(INSTRUCTOR_ID);
    await service.sync(INSTRUCTOR_ID);
    expect(shopify.operations()).not.toContain('SsmsPhotoCreate');
    expect(shopify.operations()).not.toContain('SsmsPhotoDelete');
    expect(shopify.entry('eddie-chen')?.fields.picture).toBe('');
  });
});

describe('extra photo slots', () => {
  const photo2 = `https://abc.supabase.co/storage/v1/object/public/instructor-public/${INSTRUCTOR_ID}/photo-2.png`;
  const photo3 = `https://abc.supabase.co/storage/v1/object/public/instructor-public/${INSTRUCTOR_ID}/photo-3.webp`;
  const withAllPhotos = {
    ...withPhoto,
    photo_2_url: photo2,
    photo_2_version: V1,
    photo_3_url: photo3,
    photo_3_version: V1,
  };
  const createdNames = (shopify: FakeShopify) =>
    shopify.calls
      .filter((c) => c.operation === 'SsmsPhotoCreate')
      .map((c) => (c.variables.files as { filename: string }[])[0].filename);

  it('uploads slot 2 to image_1 and slot 3 to image_2 with per-slot names and state', async () => {
    const { repo, shopify, service } = setup(withAllPhotos);

    await service.sync(INSTRUCTOR_ID);

    expect(createdNames(shopify)).toEqual([
      `instructor-${INSTRUCTOR_ID}-${V1_EPOCH}.jpg`,
      `instructor-${INSTRUCTOR_ID}-2-${V1_EPOCH}.png`,
      `instructor-${INSTRUCTOR_ID}-3-${V1_EPOCH}.webp`,
    ]);
    expect(repo.signedUrls.map((u) => u.path)).toEqual([
      `${INSTRUCTOR_ID}/avatar.jpg`,
      `${INSTRUCTOR_ID}/photo-2.png`,
      `${INSTRUCTOR_ID}/photo-3.webp`,
    ]);
    const image1 = shopify.fileNamed(
      `instructor-${INSTRUCTOR_ID}-2-${V1_EPOCH}.png`,
    );
    const image2 = shopify.fileNamed(
      `instructor-${INSTRUCTOR_ID}-3-${V1_EPOCH}.webp`,
    );
    expect(shopify.entry('eddie-chen')?.fields).toMatchObject({
      image_1: image1?.id,
      image_2: image2?.id,
    });
    expect(repo.states.get(INSTRUCTOR_ID)).toMatchObject({
      shopify_photo_2_file_id: image1?.id,
      synced_photo_2_version: V1,
      shopify_photo_3_file_id: image2?.id,
      synced_photo_3_version: V1,
    });
  });

  it('re-uploads only the slot whose version changed and deletes its old file', async () => {
    const { repo, shopify, service, setInstructor } = setup(withAllPhotos);
    await service.sync(INSTRUCTOR_ID);
    const before = { ...repo.states.get(INSTRUCTOR_ID) };

    setInstructor({ photo_2_version: V2 });
    await service.sync(INSTRUCTOR_ID);

    expect(createdNames(shopify)).toHaveLength(4);
    expect(createdNames(shopify)[3]).toBe(
      `instructor-${INSTRUCTOR_ID}-2-${V2_EPOCH}.png`,
    );
    const after = repo.states.get(INSTRUCTOR_ID);
    expect(after?.shopify_photo_2_file_id).not.toBe(
      before.shopify_photo_2_file_id,
    );
    expect(after?.synced_photo_2_version).toBe(V2);
    expect(after?.shopify_photo_file_id).toBe(before.shopify_photo_file_id);
    expect(after?.shopify_photo_3_file_id).toBe(before.shopify_photo_3_file_id);
    expect(shopify.files.has(before.shopify_photo_2_file_id as string)).toBe(
      false,
    );
    expect(shopify.files.size).toBe(3);
    expect(shopify.entry('eddie-chen')?.fields).toMatchObject({
      picture: before.shopify_photo_file_id,
      image_1: after?.shopify_photo_2_file_id,
      image_2: before.shopify_photo_3_file_id,
    });
  });

  it('does not upload anything while no slot version changed', async () => {
    const { shopify, service } = setup(withAllPhotos);
    await service.sync(INSTRUCTOR_ID);
    await service.sync(INSTRUCTOR_ID);
    expect(createdNames(shopify)).toHaveLength(3);
  });

  it('clears image_1 and deletes its file when slot 2 is removed', async () => {
    const { repo, shopify, service, setInstructor } = setup(withAllPhotos);
    await service.sync(INSTRUCTOR_ID);
    const oldId = repo.states.get(INSTRUCTOR_ID)?.shopify_photo_2_file_id;

    setInstructor({ photo_2_url: null, photo_2_version: V2 });
    await service.sync(INSTRUCTOR_ID);

    const fields = shopify.entry('eddie-chen')?.fields;
    expect(fields?.image_1).toBe('');
    expect(fields?.image_2).toBe(
      repo.states.get(INSTRUCTOR_ID)?.shopify_photo_3_file_id,
    );
    expect(shopify.files.has(oldId as string)).toBe(false);
    expect(repo.states.get(INSTRUCTOR_ID)).toMatchObject({
      shopify_photo_2_file_id: null,
      synced_photo_2_version: V2,
    });
    const ops = shopify.operations();
    expect(ops.lastIndexOf('SsmsPhotoDelete')).toBeGreaterThan(
      ops.lastIndexOf('SsmsInstructorUpsert'),
    );
  });

  it('leaves image_1 and image_2 out while the extra slots were never used', async () => {
    const { shopify, service } = setup(withPhoto);
    await service.sync(INSTRUCTOR_ID);
    await service.sync(INSTRUCTOR_ID);
    const upserts = shopify.calls.filter(
      (c) => c.operation === 'SsmsInstructorUpsert',
    );
    expect(upserts).toHaveLength(2);
    for (const call of upserts) {
      expect(JSON.stringify(call.variables)).not.toMatch(/image_[12]/);
    }
  });

  it('only uploads extra slots for a profile without a profile photo', async () => {
    const { shopify, service } = setup({
      photo_3_url: photo3,
      photo_3_version: V1,
    });
    await service.sync(INSTRUCTOR_ID);
    expect(createdNames(shopify)).toEqual([
      `instructor-${INSTRUCTOR_ID}-3-${V1_EPOCH}.webp`,
    ]);
    const fields = shopify.entry('eddie-chen')?.fields;
    expect(fields?.picture).toBeUndefined();
    expect(fields?.image_2).toBeDefined();
  });

  it('never writes to the legacy our_team type', async () => {
    const { shopify, service } = setup(withAllPhotos);
    await service.sync(INSTRUCTOR_ID);
    expect(JSON.stringify(shopify.calls)).not.toContain('our_team');
  });
});

describe('storageObject', () => {
  it('reads bucket, path and extension from a Supabase storage URL', () => {
    expect(storageObject(`${PHOTO_URL}?v=3`)).toEqual({
      bucket: 'instructor-public',
      path: `${INSTRUCTOR_ID}/avatar.jpg`,
      extension: 'jpg',
    });
    expect(
      storageObject(
        'https://x.test/storage/v1/object/sign/b/a%20b/avatar.WEBP?token=t',
      ),
    ).toEqual({ bucket: 'b', path: 'a b/avatar.WEBP', extension: 'webp' });
  });

  it.each([
    'https://cdn.test/avatar.jpg',
    'https://x.test/storage/v1/object/public/b/id/avatar',
  ])('rejects %s', (url) => {
    expect(() => storageObject(url)).toThrow('Unrecognised profile photo URL');
  });
});

describe('InstructorPhotoSync defaults', () => {
  it('falls back to the default sleep when no runtime is injected', () => {
    const repo = new InMemorySyncRepository();
    const gateway = new ShopifyInstructorGateway(new FakeShopify().client);
    expect(new InstructorPhotoSync(repo, gateway)).toBeInstanceOf(
      InstructorPhotoSync,
    );
  });
});
