import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaService } from './media.service';
import { SignedUpload, StorageClient } from './storage-client';
import { MAX_AVATAR_BYTES } from './dto/photo-upload-request.dto';
import { InstructorsService } from '../instructors/instructors.service';
import type { InstructorProfile } from '../instructors/instructors.types';

class FakeStorage implements StorageClient {
  signCalls: Array<{ bucket: string; path: string }> = [];
  createSignedUploadUrl(bucket: string, path: string): Promise<SignedUpload> {
    this.signCalls.push({ bucket, path });
    return Promise.resolve({
      signedUrl: `https://storage.test/upload/${bucket}/${path}?token=abc`,
      token: 'abc',
      path,
    });
  }
  getPublicUrl(bucket: string, path: string): string {
    return `https://storage.test/object/public/${bucket}/${path}`;
  }
}

class FakeInstructors {
  updates: Array<{ id: string; url: string | null | undefined }> = [];
  calls: string[] = [];
  updateError: Error | null = null;
  updateProfileById(id: string, dto: { profilePhotoUrl?: string | null }) {
    this.calls.push(`update:${id}`);
    if (this.updateError) {
      return Promise.reject(this.updateError);
    }
    this.updates.push({ id, url: dto.profilePhotoUrl });
    return Promise.resolve({
      id,
      profilePhotoUrl: dto.profilePhotoUrl,
    } as InstructorProfile);
  }
  bumpProfilePhotoVersion(id: string) {
    this.calls.push(`bump:${id}`);
    return Promise.resolve();
  }
  setAdditionalPhoto(id: string, slot: 2 | 3, url: string | null) {
    this.calls.push(`slot${slot}:${id}:${url}`);
    return Promise.resolve({
      id,
      [`photo${slot}Url`]: url,
    } as unknown as InstructorProfile);
  }
}

function makeService(
  storage = new FakeStorage(),
  instructors = new FakeInstructors(),
) {
  const config = {
    get: (key: string) =>
      key === 'SUPABASE_STORAGE_BUCKET' ? 'instructor-public' : undefined,
  } as unknown as ConfigService;
  const service = new MediaService(
    storage,
    config,
    instructors as unknown as InstructorsService,
  );
  return { service, storage, instructors };
}

describe('MediaService (T3.5)', () => {
  describe('createAvatarUploadUrl', () => {
    it('issues a signed URL at instructor-public/{id}/avatar.{ext}', async () => {
      const { service, storage } = makeService();
      const ticket = await service.createAvatarUploadUrl(
        'inst-1',
        'image/jpeg',
        1024,
      );
      expect(storage.signCalls).toEqual([
        { bucket: 'instructor-public', path: 'inst-1/avatar.jpg' },
      ]);
      expect(ticket.path).toBe('inst-1/avatar.jpg');
      expect(ticket.publicUrl).toBe(
        'https://storage.test/object/public/instructor-public/inst-1/avatar.jpg',
      );
      expect(ticket.maxBytes).toBe(MAX_AVATAR_BYTES);
    });

    it.each([
      ['image/png', 'png'],
      ['image/webp', 'webp'],
    ])('maps %s to .%s', async (mime, ext) => {
      const { service } = makeService();
      const ticket = await service.createAvatarUploadUrl('inst-1', mime, 1024);
      expect(ticket.path).toBe(`inst-1/avatar.${ext}`);
    });

    it('rejects a disallowed mime type (400)', async () => {
      const { service, storage } = makeService();
      await expect(
        service.createAvatarUploadUrl('inst-1', 'image/gif', 1024),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.signCalls).toHaveLength(0);
    });

    it('rejects a file over the 5 MB cap (413)', async () => {
      const { service, storage } = makeService();
      await expect(
        service.createAvatarUploadUrl(
          'inst-1',
          'image/png',
          MAX_AVATAR_BYTES + 1,
        ),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(storage.signCalls).toHaveLength(0);
    });

    it('accepts a file exactly at the 5 MB cap', async () => {
      const { service } = makeService();
      await expect(
        service.createAvatarUploadUrl('inst-1', 'image/png', MAX_AVATAR_BYTES),
      ).resolves.toBeDefined();
    });

    it('rejects a non-positive contentLength', async () => {
      const { service } = makeService();
      await expect(
        service.createAvatarUploadUrl('inst-1', 'image/png', 0),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('confirmAvatarUpload', () => {
    it('stores the recomputed public URL on the profile', async () => {
      const { service, instructors } = makeService();
      const profile = await service.confirmAvatarUpload('inst-1', 'image/jpeg');
      expect(instructors.updates).toEqual([
        {
          id: 'inst-1',
          url: 'https://storage.test/object/public/instructor-public/inst-1/avatar.jpg',
        },
      ]);
      expect(profile.profilePhotoUrl).toContain('inst-1/avatar.jpg');
    });

    it('bumps the photo version after storing the URL, even when the URL is unchanged', async () => {
      const { service, instructors } = makeService();
      await service.confirmAvatarUpload('inst-1', 'image/jpeg');
      await service.confirmAvatarUpload('inst-1', 'image/jpeg');
      expect(instructors.calls).toEqual([
        'update:inst-1',
        'bump:inst-1',
        'update:inst-1',
        'bump:inst-1',
      ]);
    });

    it('does not bump the photo version when storing the URL fails', async () => {
      const { service, instructors } = makeService();
      instructors.updateError = new Error('not found');
      await expect(
        service.confirmAvatarUpload('inst-1', 'image/png'),
      ).rejects.toThrow('not found');
      expect(instructors.calls).toEqual(['update:inst-1']);
    });

    it('rejects a disallowed mime type without touching the profile', async () => {
      const { service, instructors } = makeService();
      await expect(
        service.confirmAvatarUpload('inst-1', 'application/pdf'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(instructors.calls).toHaveLength(0);
    });
  });

  describe('photo slots', () => {
    it.each([
      [2, 'image/jpeg', 'inst-1/photo-2.jpg'],
      [3, 'image/webp', 'inst-1/photo-3.webp'],
      [1, 'image/png', 'inst-1/avatar.png'],
    ] as const)('slot %i uploads to its own path', async (slot, mime, path) => {
      const { service, storage } = makeService();
      const ticket = await service.createAvatarUploadUrl(
        'inst-1',
        mime,
        1024,
        slot,
      );
      expect(storage.signCalls).toEqual([
        { bucket: 'instructor-public', path },
      ]);
      expect(ticket.publicUrl).toBe(
        `https://storage.test/object/public/instructor-public/${path}`,
      );
    });

    it('applies the same type and size limits to every slot', async () => {
      const { service, storage } = makeService();
      await expect(
        service.createAvatarUploadUrl('inst-1', 'image/gif', 10, 2),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.createAvatarUploadUrl(
          'inst-1',
          'image/png',
          MAX_AVATAR_BYTES + 1,
          3,
        ),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(storage.signCalls).toHaveLength(0);
    });

    it('confirms slot 2 and 3 on their own columns, leaving the profile photo alone', async () => {
      const { service, instructors } = makeService();
      const profile = await service.confirmAvatarUpload(
        'inst-1',
        'image/png',
        2,
      );
      await service.confirmAvatarUpload('inst-1', 'image/jpeg', 3);
      expect(instructors.calls).toEqual([
        'slot2:inst-1:https://storage.test/object/public/instructor-public/inst-1/photo-2.png',
        'slot3:inst-1:https://storage.test/object/public/instructor-public/inst-1/photo-3.jpg',
      ]);
      expect(instructors.updates).toHaveLength(0);
      expect(profile.photo2Url).toContain('inst-1/photo-2.png');
    });

    it('removes slot 2 or 3 by clearing that slot', async () => {
      const { service, instructors } = makeService();
      await service.removePhoto('inst-1', 2);
      await service.removePhoto('inst-1', 3);
      expect(instructors.calls).toEqual([
        'slot2:inst-1:null',
        'slot3:inst-1:null',
      ]);
    });

    it('removes slot 1 through the profile update, like clearing the profile photo', async () => {
      const { service, instructors } = makeService();
      const profile = await service.removePhoto('inst-1', 1);
      expect(instructors.updates).toEqual([{ id: 'inst-1', url: null }]);
      expect(instructors.calls).toEqual(['update:inst-1']);
      expect(profile.profilePhotoUrl).toBeNull();
    });
  });
});
