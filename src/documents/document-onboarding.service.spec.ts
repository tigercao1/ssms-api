import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
} from '../../test/helpers/documents-fakes';
import {
  flushBackground,
  RecordingMailer,
} from '../../test/helpers/mailer-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import type { AuditService } from '../audit/audit.service';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentOnboardingService } from './document-onboarding.service';

function setup(env: Record<string, string> = {}) {
  const templates = new InMemoryDocumentTemplatesRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(templates);
  const subjects = new InMemoryDocumentSubjectsRepository();
  const mailer = new RecordingMailer();
  const notifications = new DocumentNotificationsService(
    mailer.asService(),
    subjects,
  );
  const assignmentsService = new DocumentAssignmentsService(
    assignments,
    templates,
    subjects,
    recordingAudit() as unknown as AuditService,
    notifications,
  );
  const service = new DocumentOnboardingService(
    { get: (k: string) => env[k] } as unknown as ConfigService,
    templates,
    subjects,
    assignmentsService,
    notifications,
  );
  const withSource = { source_key: 'templates/x/source.pdf', page_count: 1 };
  const agreement = templates.seed({
    ...withSource,
    title_en: 'Agreement',
    sort_order: 1,
  });
  const policy = templates.seed({
    ...withSource,
    kind: 'read',
    title_en: 'Policy',
    sort_order: 2,
  });
  templates.seed({ title_en: 'No PDF yet' });
  templates.seed({ ...withSource, title_en: 'Optional', required: false });
  templates.seed({ ...withSource, title_en: 'Retired', is_active: false });
  templates.seed({ ...withSource, title_en: 'Waiver', audience: 'customer' });
  const instructor = subjects.seedInstructor();
  return {
    service,
    templates,
    assignments,
    subjects,
    mailer,
    agreement,
    policy,
    instructor,
  };
}

describe('DocumentOnboardingService', () => {
  let errorLog: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('assigns the active required instructor templates that have a PDF and emails them once', async () => {
    const ctx = setup();
    await expect(
      ctx.service.assignRequired(ctx.instructor.id, '2026/27'),
    ).resolves.toEqual({ created: 2, skipped: 0 });
    expect(
      [...ctx.assignments.rows.values()].map((r) => [
        r.template_id,
        r.subject_id,
        r.season,
      ]),
    ).toEqual([
      [ctx.agreement.id, ctx.instructor.id, '2026/27'],
      [ctx.policy.id, ctx.instructor.id, '2026/27'],
    ]);
    await flushBackground();
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0]).toMatchObject({
      template: 'documents.assigned',
      to: ctx.instructor.email,
      metadata: {
        templateIds: [ctx.agreement.id, ctx.policy.id],
        season: '2026/27',
      },
    });
  });

  it('is idempotent: a repeat assigns nothing and sends no email', async () => {
    const ctx = setup();
    await ctx.service.assignRequired(ctx.instructor.id, '2026/27');
    await flushBackground();
    await expect(
      ctx.service.assignRequired(ctx.instructor.id, '2026/27'),
    ).resolves.toEqual({ created: 0, skipped: 2 });
    await flushBackground();
    expect(ctx.assignments.rows.size).toBe(2);
    expect(ctx.mailer.sent).toHaveLength(1);
  });

  it('emails only the newly assigned templates', async () => {
    const ctx = setup();
    ctx.assignments.seed({
      template_id: ctx.agreement.id,
      subject_id: ctx.instructor.id,
      season: '2026/27',
    });
    await expect(
      ctx.service.assignRequired(ctx.instructor.id, '2026/27'),
    ).resolves.toEqual({ created: 1, skipped: 1 });
    await flushBackground();
    expect(ctx.mailer.sent[0].metadata).toEqual({
      templateIds: [ctx.policy.id],
      season: '2026/27',
    });
  });

  it('uses CURRENT_SEASON without a season, and does nothing with neither', async () => {
    const ctx = setup({ CURRENT_SEASON: ' 2026-27 ' });
    await ctx.service.assignRequired(ctx.instructor.id, '  ');
    expect([...ctx.assignments.rows.values()].map((r) => r.season)).toEqual([
      '2026-27',
      '2026-27',
    ]);

    const none = setup();
    await expect(
      none.service.assignRequired(none.instructor.id),
    ).resolves.toBeNull();
    await flushBackground();
    expect(none.assignments.rows.size).toBe(0);
    expect(none.mailer.sent).toHaveLength(0);
  });

  it('resolves the instructor from the auth user', async () => {
    const ctx = setup({ CURRENT_SEASON: '2026-27' });
    await expect(
      ctx.service.assignRequiredForAuthUser(ctx.instructor.auth_user_id),
    ).resolves.toEqual({ created: 2, skipped: 0 });
    await expect(
      ctx.service.assignRequiredForAuthUser('nobody'),
    ).resolves.toBeNull();
    await expect(
      ctx.service.assignRequired('00000000-0000-4000-8000-000000000000'),
    ).resolves.toBeNull();
  });

  it('keeps going when one template fails, and emails the rest', async () => {
    const ctx = setup();
    jest
      .spyOn(ctx.assignments, 'insertMany')
      .mockRejectedValueOnce(new Error('db down'));
    await expect(
      ctx.service.assignRequired(ctx.instructor.id, '2026/27'),
    ).resolves.toEqual({ created: 1, skipped: 1 });
    await flushBackground();
    expect(ctx.mailer.sent[0].metadata).toMatchObject({
      templateIds: [ctx.policy.id],
    });
  });

  it('never throws: a failed lookup or email is logged and resolves null', async () => {
    const ctx = setup({ CURRENT_SEASON: '2026-27' });
    jest
      .spyOn(ctx.templates, 'listActiveRequired')
      .mockRejectedValueOnce(new Error('db down'));
    await expect(
      ctx.service.assignRequired(ctx.instructor.id),
    ).resolves.toBeNull();
    jest
      .spyOn(ctx.subjects, 'findInstructorByAuthUser')
      .mockRejectedValueOnce('weird');
    await expect(
      ctx.service.assignRequiredForAuthUser('x'),
    ).resolves.toBeNull();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('db down'));

    jest.spyOn(ctx.mailer, 'send').mockRejectedValueOnce(new Error('smtp'));
    await expect(
      ctx.service.assignRequired(ctx.instructor.id),
    ).resolves.toEqual({ created: 2, skipped: 0 });
    await flushBackground();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('smtp'));
  });
});
