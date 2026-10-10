import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { InstructorProfile } from '../instructors/instructors.types';
import { MediaService } from '../media/media.service';
import type { AvatarUploadTicket } from '../media/media.service';
import { AdminMediaController } from './admin-media.controller';
import { AdminService } from './admin.service';
import { ROLES_KEY, RolesGuard } from './roles.guard';

describe('AdminMediaController', () => {
  let controller: AdminMediaController;
  const ticket = { uploadUrl: 'u', publicUrl: 'p' } as AvatarUploadTicket;
  const profile = { id: 'inst-1' } as InstructorProfile;
  const media = {
    createAvatarUploadUrl: jest.fn().mockResolvedValue(ticket),
    confirmAvatarUpload: jest.fn().mockResolvedValue(profile),
    removePhoto: jest.fn().mockResolvedValue(profile),
  };
  const admin = {
    getInstructor: jest.fn().mockResolvedValue({ id: 'inst-1' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminMediaController],
      providers: [
        { provide: MediaService, useValue: media },
        { provide: AdminService, useValue: admin },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(AdminMediaController);
  });

  it('is guarded by SupabaseAuthGuard + RolesGuard requiring admin', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminMediaController)).toEqual([
      SupabaseAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminMediaController)).toEqual([
      'admin',
    ]);
  });

  it('POST signed-upload-url issues a ticket for the path instructor', async () => {
    await expect(
      controller.getSignedUploadUrl('inst-1', {
        contentType: 'image/jpeg',
        contentLength: 1024,
      }),
    ).resolves.toBe(ticket);
    expect(admin.getInstructor).toHaveBeenCalledWith('inst-1');
    expect(media.createAvatarUploadUrl).toHaveBeenCalledWith(
      'inst-1',
      'image/jpeg',
      1024,
      undefined,
    );
  });

  it('POST confirm persists the avatar on the path instructor', async () => {
    await expect(
      controller.confirm('inst-1', { contentType: 'image/png' }),
    ).resolves.toBe(profile);
    expect(media.confirmAvatarUpload).toHaveBeenCalledWith(
      'inst-1',
      'image/png',
      undefined,
    );
  });

  it('passes the requested slot through to upload and confirm', async () => {
    await controller.getSignedUploadUrl('inst-1', {
      contentType: 'image/png',
      contentLength: 10,
      slot: 2,
    });
    await controller.confirm('inst-1', { contentType: 'image/png', slot: 2 });
    expect(media.createAvatarUploadUrl).toHaveBeenCalledWith(
      'inst-1',
      'image/png',
      10,
      2,
    );
    expect(media.confirmAvatarUpload).toHaveBeenCalledWith(
      'inst-1',
      'image/png',
      2,
    );
  });

  it('DELETE :slot removes that slot on the path instructor', async () => {
    await expect(controller.remove('inst-1', 3)).resolves.toBe(profile);
    expect(admin.getInstructor).toHaveBeenCalledWith('inst-1');
    expect(media.removePhoto).toHaveBeenCalledWith('inst-1', 3);
  });

  it('DELETE :slot → 404 without removing for an unknown instructor', async () => {
    admin.getInstructor.mockRejectedValueOnce(new NotFoundException());
    await expect(controller.remove('ghost', 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(media.removePhoto).not.toHaveBeenCalled();
  });

  it('POST signed-upload-url → 404 without issuing a ticket for an unknown instructor', async () => {
    admin.getInstructor.mockRejectedValueOnce(new NotFoundException());
    await expect(
      controller.getSignedUploadUrl('ghost', {
        contentType: 'image/jpeg',
        contentLength: 1024,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(media.createAvatarUploadUrl).not.toHaveBeenCalled();
  });

  it('POST confirm → 404 without persisting for an unknown instructor', async () => {
    admin.getInstructor.mockRejectedValueOnce(new NotFoundException());
    await expect(
      controller.confirm('ghost', { contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(media.confirmAvatarUpload).not.toHaveBeenCalled();
  });
});
