import { Test } from '@nestjs/testing';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { InstructorsService } from '../instructors/instructors.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import type { InstructorProfile } from '../instructors/instructors.types';
import type { AvatarUploadTicket } from './media.service';
import { PhotoUploadRequestDto } from './dto/photo-upload-request.dto';
import { PhotoConfirmDto } from './dto/photo-confirm.dto';

describe('MediaController', () => {
  let controller: MediaController;
  const ticket = { uploadUrl: 'u', publicUrl: 'p' } as AvatarUploadTicket;
  const profile = { id: 'inst-1' } as InstructorProfile;
  const media = {
    createAvatarUploadUrl: jest.fn().mockResolvedValue(ticket),
    confirmAvatarUpload: jest.fn().mockResolvedValue(profile),
  };
  const instructors = {
    getOrCreateForUser: jest.fn().mockResolvedValue({ id: 'inst-1' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [MediaController],
      providers: [
        { provide: MediaService, useValue: media },
        { provide: InstructorsService, useValue: instructors },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(EmailVerifiedGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(MediaController);
  });

  const user = { sub: 'auth-1', email: 'a@b.com' } as SupabaseJwtPayload;

  it('POST signed-upload-url resolves the instructor id then issues a ticket', async () => {
    const dto: PhotoUploadRequestDto = {
      contentType: 'image/jpeg',
      contentLength: 1024,
    };
    await expect(controller.getSignedUploadUrl(user, dto)).resolves.toBe(
      ticket,
    );
    expect(instructors.getOrCreateForUser).toHaveBeenCalledWith(
      'auth-1',
      'a@b.com',
    );
    expect(media.createAvatarUploadUrl).toHaveBeenCalledWith(
      'inst-1',
      'image/jpeg',
      1024,
    );
  });

  it('POST confirm persists the avatar and returns the profile', async () => {
    const dto: PhotoConfirmDto = { contentType: 'image/png' };
    await expect(controller.confirm(user, dto)).resolves.toBe(profile);
    expect(media.confirmAvatarUpload).toHaveBeenCalledWith(
      'inst-1',
      'image/png',
    );
  });
});
