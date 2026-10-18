import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentOnboardingService } from '../documents/document-onboarding.service';
import { BIO_TRANSLATOR } from '../bio-translation/bio-translator.interface';
import { createBioTranslator } from '../bio-translation/bio-translation.module';
import { Test } from '@nestjs/testing';
import { InstructorsService } from '../instructors/instructors.service';
import { InstructorsRepository } from '../instructors/instructors.repository';
import { TRANSLATION_QUEUE } from '../instructors/translation-queue.port';
import type { BioChangeInput } from '../instructors/translation-queue.port';
import { AuditService } from '../audit/audit.service';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import { MailerService } from '../mailer/mailer.service';
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
    first_name: 'Jane',
    last_name: 'Doe',
    display_name_en: 'Jane',
    display_name_zh: null,
    bio_en: null,
    bio_zh: null,
    date_of_birth: null,
    profile_photo_url: null,
    min_student_age: 5,
    display_order: null,
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
    listReferences: jest.fn(),
    findReferenceById: jest.fn(),
    updateReference: jest.fn(),
    countReferenceLinks: jest.fn(),
    deleteReference: jest.fn(),
    getUserRole: jest.fn(),
    setUserRole: jest.fn(),
    revokeSessions: jest.fn(),
  };
  const instructors = {
    updateProfileById: jest.fn(),
    getProfileById: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const mailer = {
    send: jest.fn().mockResolvedValue('sent'),
    portalLink: jest.fn((path: string) => `https://portal.example.com${path}`),
  };
  const onboarding = {
    assignPublished: jest.fn().mockResolvedValue({ created: 0, skipped: 0 }),
  };
  const translator = {
    modelId: 'gemini-test',
    translate: jest.fn<Promise<string>, [Record<string, unknown>]>(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    translator.translate.mockRejectedValue(new Error('no provider'));
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: AdminRepository, useValue: repo },
        { provide: InstructorsService, useValue: instructors },
        { provide: AuditService, useValue: audit },
        { provide: MailerService, useValue: mailer },
        { provide: DocumentOnboardingService, useValue: onboarding },
        { provide: BIO_TRANSLATOR, useValue: translator },
      ],
    }).compile();

    service = moduleRef.get(AdminService);
  });

  describe('listInstructors (T6.3)', () => {
    it('maps rows to camelCase records and passes the filter through', async () => {
      repo.listInstructors.mockResolvedValue({
        rows: [
          {
            ...makeRow({ approval_status: 'approved' }),
            instructor_calendars: { instructor_id: 'i1' },
          },
          { ...makeRow({ id: 'i2' }), instructor_calendars: null },
        ],
        total: 2,
      });
      const filter: ListInstructorsFilter = { status: 'approved' };

      const { instructors: result, total } =
        await service.listInstructors(filter);

      expect(repo.listInstructors).toHaveBeenCalledWith(filter, undefined);
      expect(total).toBe(2);
      expect(result).toEqual([
        expect.objectContaining({
          email: 'jane@example.com',
          approvalStatus: 'approved',
          isActive: true,
          authUserId: '22222222-2222-4222-8222-222222222222',
          calendarConnected: true,
        }),
        expect.objectContaining({ id: 'i2', calendarConnected: false }),
      ]);
      expect(result[0]).not.toHaveProperty('instructor_calendars');
    });

    it.each([
      [{ page: 3 }, { limit: 50, offset: 100 }],
      [{ limit: 10 }, { limit: 10, offset: 0 }],
      [
        { page: 2, limit: 20 },
        { limit: 20, offset: 20 },
      ],
    ])(
      'pages only when page or limit is given (%j)',
      async ({ page, limit }: { page?: number; limit?: number }, request) => {
        repo.listInstructors.mockResolvedValue({ rows: [], total: 0 });
        await service.listInstructors({}, page, limit);
        expect(repo.listInstructors).toHaveBeenCalledWith({}, request);
      },
    );
  });

  describe('getInstructor', () => {
    it('throws 404 when not found', async () => {
      repo.findInstructorById.mockResolvedValue(null);
      await expect(service.getInstructor('x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the first and last name', async () => {
      repo.findInstructorById.mockResolvedValue(makeRow());
      const record = await service.getInstructor('id');
      expect(record.firstName).toBe('Jane');
      expect(record.lastName).toBe('Doe');
    });

    it('returns null names for instructors created before sign-up names', async () => {
      repo.findInstructorById.mockResolvedValue(
        makeRow({ first_name: null, last_name: null }),
      );
      const record = await service.getInstructor('id');
      expect(record.firstName).toBeNull();
      expect(record.lastName).toBeNull();
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
      // T8.1 — approval notification fires with instructor's language + name.
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          template: 'approved',
          to: 'jane@example.com',
          language: 'en',
          mode: 'background',
          instructorId: '11111111-1111-4111-8111-111111111111',
          vars: expect.objectContaining({
            displayName: 'Jane',
            loginUrl: 'https://portal.example.com/login?lang=en',
          }) as unknown,
        }),
      );
      expect(onboarding.assignPublished).toHaveBeenCalledWith('id', {
        approved: true,
      });
    });

    it.each([
      ['en', 'en', 'https://portal.example.com/login?lang=en'],
      ['zh-CN', 'zh-CN', 'https://portal.example.com/login?lang=zh-CN'],
      ['fr', 'bilingual', 'https://portal.example.com/login'],
    ])(
      'links a %s approval email (%s) to the login page in its language',
      async (preferred, language, loginUrl) => {
        repo.findInstructorById.mockResolvedValue(makeRow());
        repo.updateInstructor.mockResolvedValue(
          makeRow({
            approval_status: 'approved',
            preferred_language: preferred as 'en',
          }),
        );

        await service.setApprovalStatus('id', 'approved');

        expect(mailer.send).toHaveBeenCalledWith(
          expect.objectContaining({
            template: 'approved',
            language,
            vars: expect.objectContaining({ loginUrl }) as unknown,
          }),
        );
      },
    );

    it('skips the plain approval email when documents were assigned', async () => {
      repo.findInstructorById.mockResolvedValue(makeRow());
      repo.updateInstructor.mockResolvedValue(
        makeRow({ approval_status: 'approved' }),
      );
      onboarding.assignPublished.mockResolvedValueOnce({
        created: 2,
        skipped: 1,
      });

      const result = await service.setApprovalStatus('id', 'approved');

      expect(result.approvalStatus).toBe('approved');
      expect(onboarding.assignPublished).toHaveBeenCalledWith('id', {
        approved: true,
      });
      expect(mailer.send).not.toHaveBeenCalled();
    });

    it('sends the plain approval email when nothing new was assigned', async () => {
      repo.findInstructorById.mockResolvedValue(makeRow());
      repo.updateInstructor.mockResolvedValue(
        makeRow({ approval_status: 'approved' }),
      );
      onboarding.assignPublished.mockResolvedValueOnce({
        created: 0,
        skipped: 2,
      });

      await service.setApprovalStatus('id', 'approved');

      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({ template: 'approved' }),
      );
    });

    it('still approves and sends the plain approval email when assigning onboarding documents resolves null (failed)', async () => {
      repo.findInstructorById.mockResolvedValue(makeRow());
      repo.updateInstructor.mockResolvedValue(
        makeRow({ approval_status: 'approved' }),
      );
      onboarding.assignPublished.mockResolvedValueOnce(null);

      const result = await service.setApprovalStatus('id', 'approved');

      expect(result.approvalStatus).toBe('approved');
      expect(onboarding.assignPublished).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({ template: 'approved' }),
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
      // T8.1 — rejection notification carries the reason.
      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          template: 'rejected',
          vars: expect.objectContaining({ reason: 'why' }) as unknown,
        }),
      );
      expect(onboarding.assignPublished).not.toHaveBeenCalled();
    });

    it('assigns onboarding documents again when an instructor back in pending is approved', async () => {
      repo.findInstructorById.mockResolvedValueOnce(makeRow());
      repo.updateInstructor.mockResolvedValueOnce(
        makeRow({ approval_status: 'approved' }),
      );
      await service.setApprovalStatus('id', 'approved');

      repo.findInstructorById.mockResolvedValueOnce(
        makeRow({ approval_status: 'pending' }),
      );
      repo.updateInstructor.mockResolvedValueOnce(
        makeRow({ approval_status: 'approved' }),
      );
      onboarding.assignPublished.mockResolvedValueOnce({
        created: 1,
        skipped: 2,
      });
      const result = await service.setApprovalStatus('id', 'approved');

      expect(result.approvalStatus).toBe('approved');
      expect(onboarding.assignPublished).toHaveBeenCalledTimes(2);
      expect(onboarding.assignPublished).toHaveBeenLastCalledWith('id', {
        approved: true,
      });
      expect(mailer.send).toHaveBeenCalledTimes(1);
    });

    it('re-approves a rejected instructor like a pending one', async () => {
      repo.findInstructorById.mockResolvedValue(
        makeRow({ approval_status: 'rejected' }),
      );
      repo.updateInstructor.mockResolvedValue(
        makeRow({ approval_status: 'approved' }),
      );
      onboarding.assignPublished.mockResolvedValueOnce({
        created: 0,
        skipped: 0,
      });

      const result = await service.setApprovalStatus(
        'id',
        'approved',
        undefined,
        { userId: 'admin-1' },
      );

      expect(result.approvalStatus).toBe('approved');
      expect(repo.updateInstructor).toHaveBeenCalledWith('id', {
        approval_status: 'approved',
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'instructor.approve',
          actor: { userId: 'admin-1', role: 'admin' },
          metadata: { from: 'rejected', to: 'approved', reason: null },
        }),
      );
      expect(onboarding.assignPublished).toHaveBeenCalledWith('id', {
        approved: true,
      });
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({ template: 'approved' }),
      );
    });

    it('sends only the documents email when re-approval assigns documents', async () => {
      repo.findInstructorById.mockResolvedValue(
        makeRow({ approval_status: 'rejected' }),
      );
      repo.updateInstructor.mockResolvedValue(
        makeRow({ approval_status: 'approved' }),
      );
      onboarding.assignPublished.mockResolvedValueOnce({
        created: 1,
        skipped: 0,
      });

      await service.setApprovalStatus('id', 'approved');

      expect(onboarding.assignPublished).toHaveBeenCalledTimes(1);
      expect(mailer.send).not.toHaveBeenCalled();
    });

    it.each([
      ['rejected', 'rejected', "only 'pending' is allowed"],
      ['approved', 'rejected', "only 'pending' is allowed"],
      ['approved', 'approved', "only 'pending' or 'rejected' is allowed"],
    ] as const)('refuses %s → %s (400)', async (from, to, message) => {
      repo.findInstructorById.mockResolvedValue(
        makeRow({ approval_status: from }),
      );
      await expect(service.setApprovalStatus('id', to)).rejects.toThrow(
        message,
      );
      expect(repo.updateInstructor).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(onboarding.assignPublished).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
    });

    it('refuses an invalid transition from a non-pending state (400)', async () => {
      repo.findInstructorById.mockResolvedValue(
        makeRow({ approval_status: 'approved' }),
      );
      await expect(
        service.setApprovalStatus('id', 'rejected'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.updateInstructor).not.toHaveBeenCalled();
      // No state change ⇒ no audit row and no notification.
      expect(audit.record).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
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
      // T8.1 — deactivation notifies.
      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({ template: 'deactivated' }),
      );
    });

    it('sends reactivated with a sign-in link when false flips to true', async () => {
      repo.findInstructorById.mockResolvedValue(makeRow({ is_active: false }));
      repo.updateInstructor.mockResolvedValue(
        makeRow({ is_active: true, preferred_language: 'zh-CN' }),
      );
      await service.setActive('id', true);
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          template: 'reactivated',
          language: 'zh-CN',
          mode: 'background',
          vars: expect.objectContaining({
            loginUrl: 'https://portal.example.com/login?lang=zh-CN',
          }) as unknown,
        }),
      );
    });

    it('assigns published onboarding documents when an approved instructor is reactivated', async () => {
      repo.findInstructorById.mockResolvedValue(
        makeRow({ approval_status: 'approved', is_active: false }),
      );
      repo.updateInstructor.mockResolvedValue(
        makeRow({ approval_status: 'approved', is_active: true }),
      );
      onboarding.assignPublished.mockResolvedValueOnce({
        created: 1,
        skipped: 1,
      });

      await expect(service.setActive('id', true)).resolves.toMatchObject({
        isActive: true,
      });

      expect(onboarding.assignPublished).toHaveBeenCalledTimes(1);
      expect(onboarding.assignPublished).toHaveBeenCalledWith('id');
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({ template: 'reactivated' }),
      );
    });

    it('still reactivates when assigning onboarding documents resolves null (failed)', async () => {
      repo.findInstructorById.mockResolvedValue(
        makeRow({ approval_status: 'approved', is_active: false }),
      );
      repo.updateInstructor.mockResolvedValue(
        makeRow({ approval_status: 'approved', is_active: true }),
      );
      onboarding.assignPublished.mockResolvedValueOnce(null);

      await expect(service.setActive('id', true)).resolves.toMatchObject({
        isActive: true,
      });
      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({ template: 'reactivated' }),
      );
    });

    it.each(['pending', 'rejected'] as const)(
      'does not assign onboarding documents when a %s instructor is reactivated',
      async (approval) => {
        repo.findInstructorById.mockResolvedValue(
          makeRow({ approval_status: approval, is_active: false }),
        );
        repo.updateInstructor.mockResolvedValue(
          makeRow({ approval_status: approval, is_active: true }),
        );
        await service.setActive('id', true);
        expect(onboarding.assignPublished).not.toHaveBeenCalled();
      },
    );

    it('does not assign onboarding documents on deactivation or when already active', async () => {
      repo.findInstructorById.mockResolvedValue(
        makeRow({ approval_status: 'approved', is_active: true }),
      );
      repo.updateInstructor.mockResolvedValue(
        makeRow({ approval_status: 'approved', is_active: true }),
      );
      await service.setActive('id', true);
      repo.updateInstructor.mockResolvedValue(
        makeRow({ approval_status: 'approved', is_active: false }),
      );
      await service.setActive('id', false);
      expect(onboarding.assignPublished).not.toHaveBeenCalled();
    });

    it('does not notify when the active flag does not change', async () => {
      repo.findInstructorById.mockResolvedValue(makeRow({ is_active: true }));
      repo.updateInstructor.mockResolvedValue(makeRow({ is_active: true }));
      await service.setActive('id', true);
      repo.findInstructorById.mockResolvedValue(makeRow({ is_active: false }));
      repo.updateInstructor.mockResolvedValue(makeRow({ is_active: false }));
      await service.setActive('id', false);
      expect(mailer.send).not.toHaveBeenCalled();
    });

    it('survives a mailer that rejects', async () => {
      mailer.send.mockRejectedValueOnce(new Error('boom'));
      repo.findInstructorById.mockResolvedValue(makeRow());
      repo.updateInstructor.mockResolvedValue(makeRow({ is_active: false }));
      await expect(service.setActive('id', false)).resolves.toMatchObject({
        isActive: false,
      });
    });

    it('throws 404 for an unknown instructor', async () => {
      repo.findInstructorById.mockResolvedValue(null);
      await expect(service.setActive('id', true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getInstructorProfile', () => {
    it('returns the rich profile built by InstructorsService', async () => {
      const profile = { id: 'id', certifications: [], trainerStatus: [] };
      instructors.getProfileById.mockResolvedValue(profile);

      await expect(service.getInstructorProfile('id')).resolves.toBe(profile);
      expect(instructors.getProfileById).toHaveBeenCalledWith('id');
    });

    it('propagates 404 for an unknown instructor', async () => {
      instructors.getProfileById.mockRejectedValue(new NotFoundException());
      await expect(
        service.getInstructorProfile('ghost'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getUserRole', () => {
    it.each(['admin', 'instructor'] as const)(
      'returns the stored %s role',
      async (role) => {
        repo.getUserRole.mockResolvedValue({ found: true, role });
        await expect(service.getUserRole('user-9')).resolves.toEqual({ role });
        expect(repo.getUserRole).toHaveBeenCalledWith('user-9');
      },
    );

    it('maps a missing role claim to instructor', async () => {
      repo.getUserRole.mockResolvedValue({ found: true, role: null });
      await expect(service.getUserRole('user-9')).resolves.toEqual({
        role: 'instructor',
      });
    });

    it('throws 404 for an unknown user', async () => {
      repo.getUserRole.mockResolvedValue({ found: false, role: null });
      await expect(service.getUserRole('ghost')).rejects.toBeInstanceOf(
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
      expect(repo.revokeSessions).not.toHaveBeenCalled();
    });

    it('revokes the sessions of a demoted admin and audits the count', async () => {
      repo.getUserRole.mockResolvedValue({ found: true, role: 'admin' });
      repo.setUserRole.mockResolvedValue(undefined);
      repo.revokeSessions.mockResolvedValue(3);

      const result = await service.setUserRole('user-9', 'instructor', {
        userId: 'admin-1',
      });

      expect(repo.revokeSessions).toHaveBeenCalledWith('user-9');
      expect(repo.setUserRole.mock.invocationCallOrder[0]).toBeLessThan(
        repo.revokeSessions.mock.invocationCallOrder[0],
      );
      expect(result).toEqual({
        userId: 'user-9',
        role: 'instructor',
        previousRole: 'admin',
        changed: true,
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.role_change',
          targetId: 'user-9',
          metadata: { from: 'admin', to: 'instructor', sessionsRevoked: 3 },
        }),
      );
    });

    it('still audits a demotion whose session revocation fails, then surfaces the error', async () => {
      repo.getUserRole.mockResolvedValue({ found: true, role: 'admin' });
      repo.setUserRole.mockResolvedValue(undefined);
      const failure = new Error('revoke failed');
      repo.revokeSessions.mockRejectedValue(failure);

      await expect(
        service.setUserRole('user-9', 'instructor', { userId: 'admin-1' }),
      ).rejects.toBe(failure);

      expect(repo.setUserRole).toHaveBeenCalledWith('user-9', 'instructor');
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.role_change',
          targetId: 'user-9',
          metadata: { from: 'admin', to: 'instructor', sessionsRevoked: null },
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
      expect(repo.revokeSessions).not.toHaveBeenCalled();
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

  describe('minStudentAge', () => {
    it('is returned on the admin record', async () => {
      repo.findInstructorById.mockResolvedValue(
        makeRow({ min_student_age: 9 }),
      );
      const record = await service.getInstructor('id');
      expect(record.minStudentAge).toBe(9);
    });

    it('is persisted by the admin profile PATCH', async () => {
      const stored = {
        ...makeRow(),
        bio_en_machine_translated: false,
        bio_zh_machine_translated: false,
      };
      const instructorsRepo = {
        findById: jest.fn(() => Promise.resolve({ ...stored })),
        applyProfilePatch: jest.fn(
          (_id: string, patch: { min_student_age?: number }) => {
            if (patch.min_student_age !== undefined) {
              stored.min_student_age = patch.min_student_age;
            }
            return Promise.resolve();
          },
        ),
        getTeachingLocations: jest.fn().mockResolvedValue([]),
        getLanguages: jest.fn().mockResolvedValue([]),
        getCourseLevels: jest.fn().mockResolvedValue([]),
        getCertifications: jest.fn().mockResolvedValue([]),
        getTrainerStatus: jest.fn().mockResolvedValue([]),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          AdminService,
          InstructorsService,
          { provide: InstructorsRepository, useValue: instructorsRepo },
          {
            provide: TRANSLATION_QUEUE,
            useValue: { enqueueForProfile: jest.fn() },
          },
          { provide: AdminRepository, useValue: repo },
          { provide: AuditService, useValue: audit },
          { provide: MailerService, useValue: mailer },
          { provide: DocumentOnboardingService, useValue: onboarding },
          { provide: BIO_TRANSLATOR, useValue: translator },
        ],
      }).compile();

      const profile = await moduleRef
        .get(AdminService)
        .updateProfile(stored.id, { minStudentAge: 16 });

      expect(instructorsRepo.applyProfilePatch).toHaveBeenCalledWith(
        stored.id,
        { min_student_age: 16 },
      );
      expect(profile.minStudentAge).toBe(16);
    });
  });

  describe('admin bio saves', () => {
    it('still enqueue a background translation', async () => {
      let stored = { ...makeRow(), bio_en: null as string | null };
      const instructorsRepo = {
        findById: jest.fn(() => Promise.resolve({ ...stored })),
        applyProfilePatch: jest.fn(
          (_id: string, patch: { bio_en?: string }) => {
            stored = { ...stored, bio_en: patch.bio_en ?? stored.bio_en };
            return Promise.resolve();
          },
        ),
        getTeachingLocations: jest.fn().mockResolvedValue([]),
        getLanguages: jest.fn().mockResolvedValue([]),
        getCourseLevels: jest.fn().mockResolvedValue([]),
        getCertifications: jest.fn().mockResolvedValue([]),
        getTrainerStatus: jest.fn().mockResolvedValue([]),
      };
      const queue = { enqueueForProfile: jest.fn().mockResolvedValue(true) };
      const moduleRef = await Test.createTestingModule({
        providers: [
          AdminService,
          InstructorsService,
          { provide: InstructorsRepository, useValue: instructorsRepo },
          { provide: TRANSLATION_QUEUE, useValue: queue },
          { provide: AdminRepository, useValue: repo },
          { provide: AuditService, useValue: audit },
          { provide: MailerService, useValue: mailer },
          { provide: DocumentOnboardingService, useValue: onboarding },
          { provide: BIO_TRANSLATOR, useValue: translator },
        ],
      }).compile();

      await moduleRef
        .get(AdminService)
        .updateProfile(stored.id, { bioEn: 'Admin wrote this' });

      expect(instructorsRepo.applyProfilePatch).toHaveBeenCalledWith(
        stored.id,
        { bio_en: 'Admin wrote this' },
      );
      expect(queue.enqueueForProfile).toHaveBeenCalledTimes(1);
      const [change] = queue.enqueueForProfile.mock.calls[0] as [
        BioChangeInput,
      ];
      expect(change.instructorId).toBe(stored.id);
      expect(change.after.bioEn).toBe('Admin wrote this');
    });
  });

  describe('addReference (T6.7)', () => {
    it('inserts into the mapped table with defaults applied', async () => {
      const row: ReferenceRow = {
        id: 'r1',
        key: 'location.whistler',
        name: 'Whistler',
        name_zh: '惠斯勒',
        name_en_translated_by: null,
        name_zh_translated_by: null,
        sort_order: 0,
        is_active: true,
      };
      repo.insertReference.mockResolvedValue(row);

      const result = await service.addReference('teaching-locations', {
        key: 'location.whistler',
        name: 'Whistler',
        nameZh: '惠斯勒',
      });

      expect(repo.insertReference).toHaveBeenCalledWith('teaching_locations', {
        key: 'location.whistler',
        name: 'Whistler',
        nameZh: '惠斯勒',
        nameEnTranslatedBy: null,
        nameZhTranslatedBy: null,
        sortOrder: 0,
        isActive: true,
      });
      expect(translator.translate).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: 'r1',
        key: 'location.whistler',
        name: 'Whistler',
        nameZh: '惠斯勒',
        nameEnTranslatedBy: null,
        nameZhTranslatedBy: null,
        sortOrder: 0,
        isActive: true,
      });
    });

    it('translates a missing Chinese name inline and records the model', async () => {
      translator.translate.mockResolvedValue(' 惠斯勒 ');
      repo.insertReference.mockImplementation(
        (_table: string, input: Record<string, unknown>) =>
          Promise.resolve({
            id: 'r1',
            key: input.key,
            name: input.name,
            name_zh: input.nameZh,
            name_en_translated_by: input.nameEnTranslatedBy,
            name_zh_translated_by: input.nameZhTranslatedBy,
            sort_order: 0,
            is_active: true,
          }),
      );

      const result = await service.addReference('teaching-locations', {
        key: 'location.whistler',
        name: 'Whistler',
      });

      expect(translator.translate).toHaveBeenCalledWith({
        text: 'Whistler',
        from: 'en',
        to: 'zh-CN',
        kind: 'reference-name',
        timeoutMs: 8000,
      });
      expect(result).toEqual(
        expect.objectContaining({
          name: 'Whistler',
          nameZh: '惠斯勒',
          nameEnTranslatedBy: null,
          nameZhTranslatedBy: 'gemini-test',
        }),
      );
    });

    it('still saves an English-only row when its translation fails', async () => {
      repo.insertReference.mockResolvedValue({});

      await service.addReference('languages', {
        key: 'language.fr',
        name: 'French',
      });

      expect(repo.insertReference).toHaveBeenCalledWith(
        'languages',
        expect.objectContaining({
          name: 'French',
          nameZh: null,
          nameZhTranslatedBy: null,
        }),
      );
    });

    it('fills the English name from a Chinese-only row', async () => {
      translator.translate.mockResolvedValue('Mandarin');
      repo.insertReference.mockResolvedValue({});

      await service.addReference('languages', {
        key: 'language.zh',
        nameZh: '普通话',
      });

      expect(translator.translate).toHaveBeenCalledWith(
        expect.objectContaining({ text: '普通话', from: 'zh-CN', to: 'en' }),
      );
      expect(repo.insertReference).toHaveBeenCalledWith(
        'languages',
        expect.objectContaining({
          name: 'Mandarin',
          nameZh: '普通话',
          nameEnTranslatedBy: 'gemini-test',
          nameZhTranslatedBy: null,
        }),
      );
    });

    it.each([
      ['the provider fails', () => Promise.reject(new Error('HTTP 503'))],
      ['the provider returns nothing', () => Promise.resolve('  ')],
      ['the result is too long', () => Promise.resolve('x'.repeat(201))],
    ])(
      'returns 422 for a Chinese-only row when %s',
      async (_label, outcome) => {
        translator.translate.mockImplementation(outcome);

        const error = await service
          .addReference('languages', { key: 'language.zh', nameZh: '普通话' })
          .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(UnprocessableEntityException);
        expect((error as Error).message).toBe(
          'English name required (translation unavailable)',
        );
        expect(repo.insertReference).not.toHaveBeenCalled();
      },
    );

    it('returns 422 when the inline translation takes longer than 8 s', async () => {
      jest.useFakeTimers();
      try {
        translator.translate.mockImplementation(() => new Promise(() => {}));
        const pending = service
          .addReference('languages', { key: 'language.zh', nameZh: '普通话' })
          .catch((err: unknown) => err);

        await jest.advanceTimersByTimeAsync(8000);

        expect(await pending).toBeInstanceOf(UnprocessableEntityException);
      } finally {
        jest.useRealTimers();
      }
    });

    it('rejects a row with neither name (400)', async () => {
      await expect(
        service.addReference('languages', {
          key: 'language.x',
          name: ' ',
          nameZh: '',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.insertReference).not.toHaveBeenCalled();
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

  describe('reference management', () => {
    const refId = '33333333-3333-4333-8333-333333333333';
    const actor = { userId: 'admin-1', role: 'admin' as const };
    const location: ReferenceRow = {
      id: refId,
      key: 'location.whistler',
      name: 'Whistler',
      name_zh: null,
      name_en_translated_by: null,
      name_zh_translated_by: null,
      sort_order: 1,
      is_active: true,
    };
    const recordTranslation = {
      nameZh: null,
      nameEnTranslatedBy: null,
      nameZhTranslatedBy: null,
    };

    it('lists every row of the mapped table, inactive included', async () => {
      repo.listReferences.mockResolvedValue([
        location,
        { ...location, id: 'r2', key: 'location.old', is_active: false },
      ]);

      const result = await service.listReferences('teaching-locations');

      expect(repo.listReferences).toHaveBeenCalledWith('teaching_locations');
      expect(result).toEqual([
        {
          id: refId,
          key: 'location.whistler',
          name: 'Whistler',
          ...recordTranslation,
          sortOrder: 1,
          isActive: true,
        },
        {
          id: 'r2',
          key: 'location.old',
          name: 'Whistler',
          ...recordTranslation,
          sortOrder: 1,
          isActive: false,
        },
      ]);
    });

    it('deactivates a row and audits table, key and the change', async () => {
      repo.findReferenceById.mockResolvedValue(location);
      repo.updateReference.mockResolvedValue({
        ...location,
        is_active: false,
      });

      const result = await service.updateReference(
        'teaching-locations',
        refId,
        { isActive: false },
        actor,
      );

      expect(repo.updateReference).toHaveBeenCalledWith(
        'teaching_locations',
        refId,
        { is_active: false },
      );
      expect(result.isActive).toBe(false);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith({
        action: 'reference.update',
        actor: { userId: 'admin-1', role: 'admin' },
        targetType: 'reference',
        targetId: refId,
        metadata: {
          table: 'teaching_locations',
          key: 'location.whistler',
          from: { is_active: true },
          to: { is_active: false },
        },
      });
    });

    it('renames and re-sorts without touching the key', async () => {
      repo.findReferenceById.mockResolvedValue(location);
      repo.updateReference.mockResolvedValue({
        ...location,
        name: 'Whistler Blackcomb',
        sort_order: 3,
      });

      const input = {
        name: 'Whistler Blackcomb',
        sortOrder: 3,
        key: 'location.x',
      };
      const result = await service.updateReference(
        'teaching-locations',
        refId,
        input,
      );

      expect(repo.updateReference).toHaveBeenCalledWith(
        'teaching_locations',
        refId,
        {
          name: 'Whistler Blackcomb',
          name_en_translated_by: null,
          sort_order: 3,
        },
      );
      expect(result.key).toBe('location.whistler');
    });

    describe('Chinese names', () => {
      beforeEach(() => repo.updateReference.mockResolvedValue(location));

      async function patchFor(
        current: Partial<ReferenceRow>,
        input: Record<string, unknown>,
      ) {
        repo.findReferenceById.mockResolvedValue({ ...location, ...current });
        await service.updateReference('teaching-locations', refId, input);
        const [call] = repo.updateReference.mock.calls as unknown[][];
        return call[2] as Record<string, unknown>;
      }

      it('translates an English edit into an empty Chinese name', async () => {
        translator.translate.mockResolvedValue('惠斯勒黑梳山');

        expect(await patchFor({}, { name: 'Whistler Blackcomb' })).toEqual({
          name: 'Whistler Blackcomb',
          name_en_translated_by: null,
          name_zh: '惠斯勒黑梳山',
          name_zh_translated_by: 'gemini-test',
        });
      });

      it('replaces a machine-translated Chinese name after an English edit', async () => {
        translator.translate.mockResolvedValue('惠斯勒黑梳山');

        expect(
          await patchFor(
            { name_zh: '惠斯勒', name_zh_translated_by: 'gemini-old' },
            { name: 'Whistler Blackcomb' },
          ),
        ).toEqual(
          expect.objectContaining({
            name_zh: '惠斯勒黑梳山',
            name_zh_translated_by: 'gemini-test',
          }),
        );
      });

      it('never overwrites a Chinese name an admin wrote', async () => {
        const patch = await patchFor(
          { name_zh: '惠斯勒' },
          { name: 'Whistler Blackcomb' },
        );

        expect(translator.translate).not.toHaveBeenCalled();
        expect(patch).toEqual({
          name: 'Whistler Blackcomb',
          name_en_translated_by: null,
        });
      });

      it('translates a Chinese edit into a machine-translated English name', async () => {
        translator.translate.mockResolvedValue('Whistler Blackcomb');

        expect(
          await patchFor(
            { name_en_translated_by: 'gemini-old', name_zh: '惠斯勒' },
            { nameZh: '惠斯勒黑梳山' },
          ),
        ).toEqual({
          name_zh: '惠斯勒黑梳山',
          name_zh_translated_by: null,
          name: 'Whistler Blackcomb',
          name_en_translated_by: 'gemini-test',
        });
      });

      it('never overwrites an English name an admin wrote', async () => {
        expect(await patchFor({}, { nameZh: '惠斯勒' })).toEqual({
          name_zh: '惠斯勒',
          name_zh_translated_by: null,
        });
        expect(translator.translate).not.toHaveBeenCalled();
      });

      it('keeps the old English name when translating a Chinese edit fails', async () => {
        expect(
          await patchFor(
            { name_en_translated_by: 'gemini-old' },
            { nameZh: '惠斯勒' },
          ),
        ).toEqual({ name_zh: '惠斯勒', name_zh_translated_by: null });
      });

      it('does not translate when both names are edited', async () => {
        expect(
          await patchFor(
            { name_zh_translated_by: 'gemini-old', name_zh: '旧' },
            { name: 'Whistler Blackcomb', nameZh: '惠斯勒黑梳山' },
          ),
        ).toEqual({
          name: 'Whistler Blackcomb',
          name_en_translated_by: null,
          name_zh: '惠斯勒黑梳山',
          name_zh_translated_by: null,
        });
        expect(translator.translate).not.toHaveBeenCalled();
      });

      it('an admin re-saving a machine translation unchanged keeps its badge', async () => {
        expect(
          await patchFor(
            { name_zh: '惠斯勒', name_zh_translated_by: 'gemini-old' },
            { nameZh: '惠斯勒', sortOrder: 2 },
          ),
        ).toEqual({ name_zh: '惠斯勒', sort_order: 2 });
      });

      it('clears the Chinese name and its badge on an empty value', async () => {
        expect(
          await patchFor(
            { name_zh: '惠斯勒', name_zh_translated_by: 'gemini-old' },
            { nameZh: '' },
          ),
        ).toEqual({ name_zh: null, name_zh_translated_by: null });
      });

      it('returns the Chinese name and provenance on the record', async () => {
        repo.findReferenceById.mockResolvedValue(location);
        repo.updateReference.mockResolvedValue({
          ...location,
          name_zh: '惠斯勒',
          name_zh_translated_by: 'gemini-test',
        });

        const result = await service.updateReference(
          'teaching-locations',
          refId,
          { name: 'Whistler' },
        );

        expect(result).toEqual(
          expect.objectContaining({
            nameZh: '惠斯勒',
            nameEnTranslatedBy: null,
            nameZhTranslatedBy: 'gemini-test',
          }),
        );
      });
    });

    it('rejects an empty patch (400) without writing', async () => {
      await expect(
        service.updateReference('languages', refId, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.updateReference).not.toHaveBeenCalled();
    });

    it('returns 404 when updating an unknown id', async () => {
      repo.findReferenceById.mockResolvedValue(null);
      await expect(
        service.updateReference('languages', refId, { isActive: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.updateReference).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('returns 404 when the row disappears before the update lands', async () => {
      repo.findReferenceById.mockResolvedValue(location);
      repo.updateReference.mockResolvedValue(null);
      await expect(
        service.updateReference('languages', refId, { isActive: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('counts instructors linked through the matching junction', async () => {
      repo.findReferenceById.mockResolvedValue(location);
      repo.countReferenceLinks.mockResolvedValue(4);

      const result = await service.getReferenceUsage(
        'exam-preparations',
        refId,
      );

      expect(repo.findReferenceById).toHaveBeenCalledWith(
        'exam_preparations',
        refId,
      );
      expect(repo.countReferenceLinks).toHaveBeenCalledWith(
        {
          table: 'instructors_exam_preparations',
          column: 'exam_preparation_id',
        },
        refId,
      );
      expect(result).toEqual({ instructorCount: 4 });
    });

    it('returns 404 for usage of an unknown id', async () => {
      repo.findReferenceById.mockResolvedValue(null);
      await expect(
        service.getReferenceUsage('languages', refId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.countReferenceLinks).not.toHaveBeenCalled();
    });

    it('hard-deletes a row and audits the removed link count', async () => {
      repo.findReferenceById.mockResolvedValue(location);
      repo.countReferenceLinks.mockResolvedValue(2);
      repo.deleteReference.mockResolvedValue(location);

      const result = await service.deleteReference(
        'teaching-locations',
        refId,
        actor,
      );

      expect(repo.countReferenceLinks).toHaveBeenCalledWith(
        {
          table: 'instructors_teaching_locations',
          column: 'teaching_location_id',
        },
        refId,
      );
      expect(repo.deleteReference).toHaveBeenCalledWith(
        'teaching_locations',
        refId,
      );
      expect(result).toEqual({
        id: refId,
        key: 'location.whistler',
        name: 'Whistler',
        ...recordTranslation,
        sortOrder: 1,
        isActive: true,
        removedLinkCount: 2,
      });
      expect(audit.record).toHaveBeenCalledWith({
        action: 'reference.delete',
        actor: { userId: 'admin-1', role: 'admin' },
        targetType: 'reference',
        targetId: refId,
        metadata: {
          table: 'teaching_locations',
          key: 'location.whistler',
          name: 'Whistler',
          removedLinkCount: 2,
        },
      });
    });

    it('returns 404 when deleting an unknown id', async () => {
      repo.findReferenceById.mockResolvedValue(null);
      await expect(
        service.deleteReference('languages', refId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.deleteReference).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('returns 404 when the row is already gone at delete time', async () => {
      repo.findReferenceById.mockResolvedValue(location);
      repo.countReferenceLinks.mockResolvedValue(0);
      repo.deleteReference.mockResolvedValue(null);
      await expect(
        service.deleteReference('languages', refId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});

describe('AdminService reference translation gate', () => {
  const repo = {
    insertReference: jest.fn((_table: string, input: Record<string, unknown>) =>
      Promise.resolve({
        id: 'r1',
        key: input.key,
        name: input.name,
        name_zh: input.nameZh,
        name_en_translated_by: input.nameEnTranslatedBy,
        name_zh_translated_by: input.nameZhTranslatedBy,
        sort_order: 0,
        is_active: true,
      }),
    ),
  };
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '翻译' }] } }],
        }),
        { status: 200 },
      ),
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  async function serviceWith(env: Record<string, string>) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: AdminRepository, useValue: repo },
        { provide: InstructorsService, useValue: {} },
        { provide: AuditService, useValue: { record: jest.fn() } },
        { provide: MailerService, useValue: {} },
        { provide: DocumentOnboardingService, useValue: {} },
        {
          provide: BIO_TRANSLATOR,
          useFactory: createBioTranslator,
          inject: [ConfigService],
        },
        { provide: ConfigService, useValue: new ConfigService(env) },
      ],
    }).compile();
    return moduleRef.get(AdminService);
  }

  describe.each([
    [{ GEMINI_API_KEY: 'k' }],
    [{ GEMINI_API_KEY: 'k', TRANSLATION_ENABLED: 'false' }],
  ])('with translation disabled (%j)', (env) => {
    it('saves an English-only row without a Chinese name or a Gemini call', async () => {
      const record = await (
        await serviceWith(env)
      ).addReference('languages', { key: 'language.fr', name: 'French' });

      expect(record).toEqual(
        expect.objectContaining({
          name: 'French',
          nameZh: null,
          nameZhTranslatedBy: null,
        }),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a Chinese-only row with 422 and no Gemini call', async () => {
      const error = await (await serviceWith(env))
        .addReference('languages', { key: 'language.zh', nameZh: '普通话' })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect((error as Error).message).toBe(
        'English name required (translation unavailable)',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it('translates inline through Gemini when TRANSLATION_ENABLED=true', async () => {
    const record = await (
      await serviceWith({
        GEMINI_API_KEY: 'k',
        GEMINI_MODEL: 'gemini-test',
        TRANSLATION_ENABLED: 'true',
      })
    ).addReference('languages', { key: 'language.fr', name: 'French' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(record).toEqual(
      expect.objectContaining({
        nameZh: '翻译',
        nameZhTranslatedBy: 'gemini-test',
      }),
    );
  });
});
