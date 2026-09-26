import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import type { AdminInstructorRecord } from './admin.types';
import { ROLES_KEY, RolesGuard } from './roles.guard';

const fakeRecord = { id: 'inst-1' } as AdminInstructorRecord;

describe('AdminController', () => {
  let controller: AdminController;
  const service = {
    listInstructors: jest.fn().mockResolvedValue([fakeRecord]),
    getInstructor: jest.fn().mockResolvedValue(fakeRecord),
    getInstructorProfile: jest.fn().mockResolvedValue({ id: 'inst-1' }),
    getUserRole: jest.fn().mockResolvedValue({ role: 'instructor' }),
    setApprovalStatus: jest.fn().mockResolvedValue(fakeRecord),
    setActive: jest.fn().mockResolvedValue(fakeRecord),
    setUserRole: jest
      .fn()
      .mockResolvedValue({ userId: 'user-9', role: 'admin', changed: true }),
    updateProfile: jest.fn().mockResolvedValue({ id: 'inst-1' }),
    addReference: jest.fn().mockResolvedValue({ id: 'r1' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AdminService, useValue: service }],
    })
      // guards covered in roles.guard.spec / auth module; stub them open here.
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(AdminController);
  });

  it('GET /admin/instructors → forwards status+active filter', async () => {
    await controller.listInstructors({ status: 'pending', active: false });
    expect(service.listInstructors).toHaveBeenCalledWith({
      status: 'pending',
      isActive: false,
    });
  });

  it('GET /admin/instructors/:id → getInstructor(id)', async () => {
    await expect(controller.getInstructor('inst-1')).resolves.toBe(fakeRecord);
    expect(service.getInstructor).toHaveBeenCalledWith('inst-1');
  });

  it('GET /admin/instructors/:id/profile → getInstructorProfile(id)', async () => {
    await expect(controller.getInstructorProfile('inst-1')).resolves.toEqual({
      id: 'inst-1',
    });
    expect(service.getInstructorProfile).toHaveBeenCalledWith('inst-1');
  });

  it('GET /admin/instructors/:id/profile → propagates 404', async () => {
    service.getInstructorProfile.mockRejectedValueOnce(new NotFoundException());
    await expect(
      controller.getInstructorProfile('ghost'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GET /admin/users/:id/role → getUserRole(id)', async () => {
    await expect(controller.getUserRole('user-9')).resolves.toEqual({
      role: 'instructor',
    });
    expect(service.getUserRole).toHaveBeenCalledWith('user-9');
  });

  it('GET /admin/users/:id/role → propagates 404', async () => {
    service.getUserRole.mockRejectedValueOnce(new NotFoundException());
    await expect(controller.getUserRole('ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('is guarded by SupabaseAuthGuard + RolesGuard requiring admin', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminController)).toEqual([
      SupabaseAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminController)).toEqual(['admin']);
  });

  const adminUser = {
    sub: 'admin-1',
    app_metadata: { role: 'admin' },
  } as unknown as Parameters<typeof controller.setApproval>[2];

  it('PATCH approval → setApprovalStatus(id, status, reason, actor)', async () => {
    await controller.setApproval(
      'inst-1',
      { approvalStatus: 'rejected', reason: 'incomplete' },
      adminUser,
      'jest-agent',
    );
    expect(service.setApprovalStatus).toHaveBeenCalledWith(
      'inst-1',
      'rejected',
      'incomplete',
      { userId: 'admin-1', role: 'admin', userAgent: 'jest-agent' },
    );
  });

  it('PATCH activation → setActive(id, isActive, actor)', async () => {
    await controller.setActivation('inst-1', { isActive: false }, adminUser);
    expect(service.setActive).toHaveBeenCalledWith('inst-1', false, {
      userId: 'admin-1',
      role: 'admin',
      userAgent: null,
    });
  });

  it('PATCH users/:id/role → setUserRole(id, role, actor)', async () => {
    await controller.setUserRole('user-9', { role: 'admin' }, adminUser, 'ua');
    expect(service.setUserRole).toHaveBeenCalledWith('user-9', 'admin', {
      userId: 'admin-1',
      role: 'admin',
      userAgent: 'ua',
    });
  });

  it('PATCH :id → updateProfile(id, dto) (T6.6)', async () => {
    const dto = { displayNameEn: 'Jane' };
    await controller.updateProfile('inst-1', dto);
    expect(service.updateProfile).toHaveBeenCalledWith('inst-1', dto);
  });

  it('POST reference/:type → addReference(slug, dto)', async () => {
    const dto = { key: 'language.fr', name: 'French' };
    await controller.addReference('languages', dto);
    expect(service.addReference).toHaveBeenCalledWith('languages', dto);
  });

  it('POST reference/:type → 400 on an unknown slug', () => {
    expect(() =>
      controller.addReference('not-a-type', { key: 'k', name: 'n' }),
    ).toThrow(BadRequestException);
    expect(service.addReference).not.toHaveBeenCalled();
  });
});
