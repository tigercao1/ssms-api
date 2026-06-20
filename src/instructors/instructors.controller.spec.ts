import { Test } from '@nestjs/testing';
import { InstructorsController } from './instructors.controller';
import { InstructorsService } from './instructors.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import type { InstructorProfile } from './instructors.types';
import type { UpdateInstructorProfileDto } from './dto/update-instructor-profile.dto';

const fakeProfile = { id: 'inst-1' } as InstructorProfile;

describe('InstructorsController', () => {
  let controller: InstructorsController;
  const service = {
    getOrCreateForUser: jest.fn().mockResolvedValue(fakeProfile),
    updateOwnProfile: jest.fn().mockResolvedValue(fakeProfile),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [InstructorsController],
      providers: [{ provide: InstructorsService, useValue: service }],
    })
      // guards aren't exercised here (covered by auth module); stub them open
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(EmailVerifiedGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(InstructorsController);
  });

  const user = { sub: 'auth-1', email: 'a@b.com' } as SupabaseJwtPayload;

  it('GET /me/instructor → getOrCreateForUser(sub, email)', async () => {
    await expect(controller.getMe(user)).resolves.toBe(fakeProfile);
    expect(service.getOrCreateForUser).toHaveBeenCalledWith(
      'auth-1',
      'a@b.com',
    );
  });

  it('GET passes empty string when token has no email claim', async () => {
    await controller.getMe({ sub: 'auth-2' });
    expect(service.getOrCreateForUser).toHaveBeenCalledWith('auth-2', '');
  });

  it('PATCH /me/instructor → updateOwnProfile(sub, dto)', async () => {
    const dto = { displayNameEn: 'Jane' } as UpdateInstructorProfileDto;
    await expect(controller.updateMe(user, dto)).resolves.toBe(fakeProfile);
    expect(service.updateOwnProfile).toHaveBeenCalledWith('auth-1', dto);
  });
});
