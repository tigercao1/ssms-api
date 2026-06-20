import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InstructorsService } from '../instructors/instructors.service';
import { AuditService } from '../audit/audit.service';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import {
  AdminInstructorRow,
  ListInstructorsFilter,
  ReferenceRow,
} from './admin.types';

function makeRow(over: Partial<AdminInstructorRow> = {}): AdminInstructorRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    auth_user_id: '22222222-2222-4222-8222-222222222222',
    email: 'jane@example.com',
    display_name_en: 'Jane',
    display_name_zh: null,
    bio_en: null,
    bio_zh: null,
    date_of_birth: null,
    profile_photo_url: null,
    preferred_language: 'en',
    approval_status: 'pending',
    is_active: true,
    inserted_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('AdminService', () => {
  let service: AdminService;
  // Plain object mocks (not typed as the class) so `expect(repo.method)` does
  // not trip eslint's unbound-method rule — same pattern as the controller spec.
  const repo = {
    listInstructors: jest.fn(),
    findInstructorById: jest.fn(),
    updateInstructor: jest.fn(),
    insertReference: jest.fn(),
    getUserRole: jest.fn(),
    setUserRole: jest.fn(),
  };
  const instructors = { updateProfileById: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: AdminRepository, useValue: repo },
        { provide: InstructorsService, useValue: instructors },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(AdminService);
  });

  describe('listInstructors (T6.3)', () => {
    it('maps rows to camelCase records and passes the filter through', async () => {
      repo.listInstructors.mockResolvedValue([
        makeRow({ approval_status: 'approved' }),
      ]);
      const filter: ListInstructorsFilter = { status: 'approved' };

      const result = await service.listInstructors(filter);

      expect(repo.listInstructors).toHaveBeenCalledWith(filter);
      expect(result).toEqual([
        expect.objectContaining({
          email: 'jane@example.com',
          approvalStatus: 'approved',
          isActive: true,
          authUserId: '22222222-2222-4222-8222-222222222222',
        }),
      ]);
    });
  });

  describe('getInstructor', () => {
    it('throws 404 when not found', async () => {
      repo.findInstructorById.mockResolvedValue(null);
      await expect(service.getInstructor('x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('setApprovalStatus (T6.4)', () => {
    it('approves a pending instructor', async () => {
      repo.findInstructorById.mockResolvedValue(makeRow());
      repo.updateInstructor.mockResolvedValue(
        makeRow({ approval_status: 'approved' }),
      );

      const result = await service.setApprovalStatus(
        'id',
        'approved',
        undefined,
        {
          userId: 'admin-1',
        },
      );

      expect(repo.updateInstructor).toHaveBeenCalledWith('id', {
        approval_status: 'approved',
      });
      expect(result.approvalStatus).toBe('approved');
      // T6.8 — exactly one audit row, action + actor + reason captured.
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'instructor.approve',
          targetType: 'instructor',
          targetId: 'id',
          actor: { userId: 'admin-1', role: 'admin' },
        }),
      );
    });

    it('rejects a pending instructor', async () => {
      repo.findInstructorById.mockResolvedValue(makeRow());
      repo.updateInstructor.mockResolvedValue(
        makeRow({ approval_status: 'rejected' }),
      );

      const result = await service.setApprovalStatus('id', 'rejected', 'why');
      expect(result.approvalStatus).toBe('rejected');
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'instructor.reject',
          metadata: { from: 'pending', to: 'rejected', reason: 'why' },
        }),
      );
    });

    it('refuses an invalid transition from a non-pending state (400)', async () => {
      repo.findInstructorById.mockResolvedValue(
        makeRow({ approval_status: 'approved' }),
      );
      await expect(
        service.setApprovalStatus('id', 'rejected'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.updateInstructor).not.toHaveBeenCalled();
      // No state change ⇒ no audit row.
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown instructor', async () => {
      repo.findInstructorById.mockResolvedValue(null);
      await expect(
        service.setApprovalStatus('id', 'approved'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setActive (T6.5)', () => {
    it('deactivates an instructor', async () => {
      repo.findInstructorById.mockResolvedValue(makeRow());
      repo.updateInstructor.mockResolvedValue(makeRow({ is_active: false }));

      const result = await service.setActive('id', false, {
        userId: 'admin-1',
      });

      expect(repo.updateInstructor).toHaveBeenCalledWith('id', {
        is_active: false,
      });
      expect(result.isActive).toBe(false);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'instructor.deactivate',
          targetId: 'id',
          actor: { userId: 'admin-1', role: 'admin' },
        }),
      );
    });

    it('throws 404 for an unknown instructor', async () => {
      repo.findInstructorById.mockResolvedValue(null);
      await expect(service.setActive('id', true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('setUserRole (v1.x)', () => {
    it('promotes a user and writes exactly one user.role_change audit row', async () => {
      repo.getUserRole.mockResolvedValue({ found: true, role: 'instructor' });
      repo.setUserRole.mockResolvedValue(undefined);

      const result = await service.setUserRole('user-9', 'admin', {
        userId: 'admin-1',
      });

      expect(repo.setUserRole).toHaveBeenCalledWith('user-9', 'admin');
      expect(result).toEqual({
        userId: 'user-9',
        role: 'admin',
        previousRole: 'instructor',
        changed: true,
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.role_change',
          targetType: 'user',
          targetId: 'user-9',
          actor: { userId: 'admin-1', role: 'admin' },
          metadata: { from: 'instructor', to: 'admin' },
        }),
      );
    });

    it('is an idempotent no-op (no write, no audit) when role is unchanged', async () => {
      repo.getUserRole.mockResolvedValue({ found: true, role: 'admin' });

      const result = await service.setUserRole('user-9', 'admin', {
        userId: 'admin-1',
      });

      expect(result.changed).toBe(false);
      expect(repo.setUserRole).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('treats a user with no role claim as a plain instructor (promotable)', async () => {
      repo.getUserRole.mockResolvedValue({ found: true, role: null });
      repo.setUserRole.mockResolvedValue(undefined);

      const result = await service.setUserRole('user-9', 'admin', {
        userId: 'admin-1',
      });

      expect(result.previousRole).toBeNull();
      expect(result.changed).toBe(true);
    });

    it('refuses to let an admin change their own role (400)', async () => {
      await expect(
        service.setUserRole('admin-1', 'instructor', { userId: 'admin-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.getUserRole).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown user', async () => {
      repo.getUserRole.mockResolvedValue({ found: false, role: null });
      await expect(
        service.setUserRole('ghost', 'admin', { userId: 'admin-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.setUserRole).not.toHaveBeenCalled();
    });
  });

  describe('updateProfile (T6.6)', () => {
    it('delegates to InstructorsService.updateProfileById', async () => {
      const profile = { id: 'id' };
      instructors.updateProfileById.mockResolvedValue(profile);
      const dto = { displayNameEn: 'New' };

      const result = await service.updateProfile('id', dto);

      expect(instructors.updateProfileById).toHaveBeenCalledWith('id', dto);
      expect(result).toBe(profile);
    });
  });

  describe('addReference (T6.7)', () => {
    it('inserts into the mapped table with defaults applied', async () => {
      const row: ReferenceRow = {
        id: 'r1',
        key: 'location.whistler',
        name: 'Whistler',
        sort_order: 0,
        is_active: true,
      };
      repo.insertReference.mockResolvedValue(row);

      const result = await service.addReference('teaching-locations', {
        key: 'location.whistler',
        name: 'Whistler',
      });

      expect(repo.insertReference).toHaveBeenCalledWith('teaching_locations', {
        key: 'location.whistler',
        name: 'Whistler',
        sortOrder: 0,
        isActive: true,
      });
      expect(result).toEqual({
        id: 'r1',
        key: 'location.whistler',
        name: 'Whistler',
        sortOrder: 0,
        isActive: true,
      });
    });

    it('maps a duplicate key (23505) to 409 Conflict', async () => {
      repo.insertReference.mockRejectedValue({ code: '23505' });
      await expect(
        service.addReference('languages', {
          key: 'language.en',
          name: 'English',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
