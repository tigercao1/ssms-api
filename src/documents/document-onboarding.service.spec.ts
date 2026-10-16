import { Logger } from '@nestjs/common';
import {
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
} from '../../test/helpers/documents-fakes';
import { seasonsService } from '../../test/helpers/seasons-fakes';
import {
  flushBackground,
  RecordingMailer,
} from '../../test/helpers/mailer-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import type { AuditService } from '../audit/audit.service';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentOnboardingService } from './document-onboarding.service';

function setup() {
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
    seasonsService(),
  );
  const service = new DocumentOnboardingService(
    templates,
    subjects,
    assignmentsService,
    notifications,
  );
  const published = {
    source_key: 'templates/x/source.pdf',
    page_count: 1,
    status: 'live' as const,
    assign_to: 'all' as const,
    season: '2026/27',
  };
  const agreement = templates.seed({
    ...published,
    title_en: 'Agreement',
    sort_order: 1,
  });
  const policy = templates.seed({
    ...published,
    kind: 'read',
    title_en: 'Policy',
    required: false,
    sort_order: 2,
  });
  templates.seed({ ...published, title_en: 'No PDF yet', source_key: null });
  templates.seed({ ...published, title_en: 'Selected', assign_to: 'selected' });
  templates.seed({
    ...published,
    title_en: 'Draft',
    status: 'draft',
    assign_to: null,
    season: null,
  });
  templates.seed({ ...published, title_en: 'Retired', status: 'retired' });
  templates.seed({ ...published, title_en: 'Waiver', audience: 'customer' });
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

  it('assigns every live template published to all, required or not, and emails them once', async () => {
    const ctx = setup();
    await expect(
      ctx.service.assignPublished(ctx.instructor.id),
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
      vars: { approved: false },
      metadata: {
        templateIds: [ctx.agreement.id, ctx.policy.id],
        season: '2026/27',
        approved: false,
      },
    });
  });

  it('assigns each template for its own season and opens the email with the approval', async () => {
    const ctx = setup();
    const lastSeason = ctx.templates.seed({
      source_key: 'templates/y/source.pdf',
      status: 'live',
      assign_to: 'all',
      season: '2025/26',
      title_en: 'Handbook',
      sort_order: 3,
    });
    await expect(
      ctx.service.assignPublished(ctx.instructor.id, { approved: true }),
    ).resolves.toEqual({ created: 3, skipped: 0 });
    expect(
      [...ctx.assignments.rows.values()].find(
        (r) => r.template_id === lastSeason.id,
      )?.season,
    ).toBe('2025/26');
    await flushBackground();
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0]).toMatchObject({
      vars: { approved: true },
      metadata: { season: null, approved: true },
    });
  });

  it.each(['pending', 'rejected'])(
    'assigns nothing to a %s instructor',
    async (approval) => {
      const ctx = setup();
      const pending = ctx.subjects.seedInstructor({
        approval_status: approval,
      });
      await expect(ctx.service.assignPublished(pending.id)).resolves.toBeNull();
      await expect(
        ctx.service.assignPublishedForAuthUser(pending.auth_user_id),
      ).resolves.toBeNull();
      await flushBackground();
      expect(ctx.assignments.rows.size).toBe(0);
      expect(ctx.mailer.sent).toHaveLength(0);
    },
  );

  it('assigns a live read document published to all and lists it in the email on approval and on activation', async () => {
    const ctx = setup();
    const activated = ctx.subjects.seedInstructor({
      email: 'activated@example.com',
    });
    await ctx.service.assignPublished(ctx.instructor.id, { approved: true });
    await ctx.service.assignPublishedForAuthUser(activated.auth_user_id);
    await flushBackground();
    for (const instructor of [ctx.instructor, activated]) {
      expect(
        [...ctx.assignments.rows.values()].some(
          (r) =>
            r.template_id === ctx.policy.id && r.subject_id === instructor.id,
        ),
      ).toBe(true);
    }
    expect(
      ctx.mailer
        .sentOf('documents.assigned')
        .map((m) => [m.to, m.vars.approved, m.vars.documents]),
    ).toEqual([
      [
        ctx.instructor.email,
        true,
        [
          { titleEn: 'Agreement', titleZh: null, kind: 'sign' },
          { titleEn: 'Policy', titleZh: null, kind: 'read' },
        ],
      ],
      [
        'activated@example.com',
        false,
        [
          { titleEn: 'Agreement', titleZh: null, kind: 'sign' },
          { titleEn: 'Policy', titleZh: null, kind: 'read' },
        ],
      ],
    ]);
  });

  it('is idempotent: a repeat assigns nothing and sends no email', async () => {
    const ctx = setup();
    await ctx.service.assignPublished(ctx.instructor.id);
    await flushBackground();
    await expect(
      ctx.service.assignPublished(ctx.instructor.id),
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
      ctx.service.assignPublished(ctx.instructor.id),
    ).resolves.toEqual({ created: 1, skipped: 1 });
    await flushBackground();
    expect(ctx.mailer.sent[0].metadata).toEqual({
      templateIds: [ctx.policy.id],
      season: '2026/27',
      approved: false,
    });
  });

  it('resolves the instructor from the auth user', async () => {
    const ctx = setup();
    await expect(
      ctx.service.assignPublishedForAuthUser(ctx.instructor.auth_user_id),
    ).resolves.toEqual({ created: 2, skipped: 0 });
    await expect(
      ctx.service.assignPublishedForAuthUser('nobody'),
    ).resolves.toBeNull();
    await expect(
      ctx.service.assignPublished('00000000-0000-4000-8000-000000000000'),
    ).resolves.toBeNull();
  });

  it('keeps going when one template fails, and emails the rest', async () => {
    const ctx = setup();
    jest
      .spyOn(ctx.assignments, 'insertMany')
      .mockRejectedValueOnce(new Error('db down'));
    await expect(
      ctx.service.assignPublished(ctx.instructor.id),
    ).resolves.toEqual({ created: 1, skipped: 1 });
    await flushBackground();
    expect(ctx.mailer.sent[0].metadata).toMatchObject({
      templateIds: [ctx.policy.id],
    });
  });

  it('never throws: a failed lookup or email is logged and resolves null', async () => {
    const ctx = setup();
    jest
      .spyOn(ctx.templates, 'listLiveForAll')
      .mockRejectedValueOnce(new Error('db down'));
    await expect(
      ctx.service.assignPublished(ctx.instructor.id),
    ).resolves.toBeNull();
    jest
      .spyOn(ctx.subjects, 'findInstructorByAuthUser')
      .mockRejectedValueOnce('weird');
    await expect(
      ctx.service.assignPublishedForAuthUser('x'),
    ).resolves.toBeNull();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('db down'));

    jest.spyOn(ctx.mailer, 'send').mockRejectedValueOnce(new Error('smtp'));
    await expect(
      ctx.service.assignPublished(ctx.instructor.id),
    ).resolves.toEqual({ created: 2, skipped: 0 });
    await flushBackground();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('smtp'));
  });
});
