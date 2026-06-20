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
  updateProfileById(id: string, dto: { profilePhotoUrl?: string | null }) {
    this.updates.push({ id, url: dto.profilePhotoUrl });
    return Promise.resolve({
      id,
      profilePhotoUrl: dto.profilePhotoUrl,
    } as InstructorProfile);
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

    it('rejects a disallowed mime type without touching the profile', async () => {
      const { service, instructors } = makeService();
      await expect(
        service.confirmAvatarUpload('inst-1', 'application/pdf'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(instructors.updates).toHaveLength(0);
    });
  });
});
