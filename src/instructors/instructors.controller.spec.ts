import { Test } from '@nestjs/testing';
import { InstructorsController } from './instructors.controller';
import { InstructorsService } from './instructors.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import type { InstructorProfile } from './instructors.types';
import type { UpdateOwnInstructorProfileDto } from './dto/update-own-instructor-profile.dto';
import { BioDraftService } from './bio-draft.service';
import type { BioDraftDto } from './dto/bio-draft.dto';

const fakeProfile = { id: 'inst-1' } as InstructorProfile;

describe('InstructorsController', () => {
  let controller: InstructorsController;
  const service = {
    getOrCreateForUser: jest.fn().mockResolvedValue(fakeProfile),
    updateOwnProfile: jest.fn().mockResolvedValue(fakeProfile),
  };
  const usage = { limit: 5, used: 0, remaining: 5, resetsAt: null };
  const bioDrafts = {
    getUsage: jest.fn().mockResolvedValue(usage),
    draft: jest.fn().mockResolvedValue({ en: 'a', zh: 'b', model: 'm', usage }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [InstructorsController],
      providers: [
        { provide: InstructorsService, useValue: service },
        { provide: BioDraftService, useValue: bioDrafts },
      ],
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
    const dto = { displayNameEn: 'Jane' } as UpdateOwnInstructorProfileDto;
    await expect(controller.updateMe(user, dto)).resolves.toBe(fakeProfile);
    expect(service.updateOwnProfile).toHaveBeenCalledWith('auth-1', dto);
  });

  it('GET /me/instructor/bio/ai-usage → getUsage(sub)', async () => {
    await expect(controller.getBioAiUsage(user)).resolves.toBe(usage);
    expect(bioDrafts.getUsage).toHaveBeenCalledWith('auth-1');
  });

  it('POST /me/instructor/bio/draft → draft(sub, dto)', async () => {
    const dto: BioDraftDto = { text: 'Hi', mode: 'refine' };
    await controller.draftBio(user, dto);
    expect(bioDrafts.draft).toHaveBeenCalledWith('auth-1', dto);
  });
});
