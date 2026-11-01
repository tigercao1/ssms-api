import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  ADMIN_ID,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import {
  cappedSupabase,
  POSTGREST_MAX_ROWS,
} from '../../test/helpers/capped-supabase';
import { certificationUploadRow } from '../../test/helpers/documents-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import {
  goLiveFor,
  InMemorySyncRepository,
  readySnapshotOf,
  verifiedUpload,
} from '../../test/helpers/shopify-sync-fakes';
import { BIO_TRANSLATOR } from '../bio-translation/bio-translator.interface';
import { torontoToday } from '../documents/certification-validity';
import { DocumentOnboardingService } from '../documents/document-onboarding.service';
import { InstructorsService } from '../instructors/instructors.service';
import { MailerService } from '../mailer/mailer.service';
import { SeasonsService } from '../seasons/seasons.service';
import {
  GoLiveService,
  type InstructorSummary,
} from '../shopify-sync/go-live.service';
import {
  INSTRUCTOR_STAGES,
  type InstructorStage,
} from '../shopify-sync/instructor-stage';
import type { SyncCertRow } from '../shopify-sync/instructor-sync.types';
import { AuditService } from '../audit/audit.service';
import { AdminController } from './admin.controller';
import { AdminRepository, SupabaseAdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import type {
  AdminInstructorListRecord,
  AdminInstructorListRow,
  ListInstructorsFilter,
} from './admin.types';

const EXPORT = '/admin/instructors/export.csv';
const HEADER =
  'Name,Email,Phone,Date of Birth,Certifications,MSLM Podium Pass Holder';

const idOf = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const authIdOf = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function makeRow(
  n: number,
  overrides: Partial<AdminInstructorListRow> = {},
): AdminInstructorListRow {
  return {
    id: idOf(n),
    auth_user_id: authIdOf(n),
    email: `coach${n}@example.com`,
    first_name: 'Coach',
    last_name: `${n}`,
    display_name_en: `Nick ${n}`,
    display_name_zh: '教练',
    bio_en: null,
    bio_zh: null,
    date_of_birth: null,
    profile_photo_url: null,
    min_student_age: 5,
    display_order: null,
    preferred_language: 'zh-CN',
    approval_status: 'approved',
    is_active: true,
    inserted_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    updated_at: '2026-01-01T00:00:00.000Z',
    instructor_calendars: n % 2 === 0 ? { instructor_id: idOf(n) } : null,
    ...overrides,
  };
}

class InMemoryInstructors {
  rows: AdminInstructorListRow[] = [];
  calls: ListInstructorsFilter[] = [];
  locations = new Map<string, Set<string>>();
  locationCalls: string[] = [];

  listInstructorIdsAtLocation(key: string): Promise<Set<string>> {
    this.locationCalls.push(key);
    return Promise.resolve(new Set(this.locations.get(key)));
  }

  listInstructors(): never {
    throw new Error('the export never pages');
  }

  listAllInstructors(
    filter: ListInstructorsFilter,
  ): Promise<AdminInstructorListRow[]> {
    this.calls.push(filter);
    return Promise.resolve(
      this.rows
        .filter((r) => !filter.status || r.approval_status === filter.status)
        .filter(
          (r) =>
            filter.isActive === undefined || r.is_active === filter.isActive,
        )
        .filter(
          (r) =>
            filter.calendarConnected === undefined ||
            (r.instructor_calendars !== null) === filter.calendarConnected,
        )
        .filter(
          (r) =>
            !filter.q ||
            [r.display_name_en, r.email].some((field) =>
              field.toLowerCase().includes(filter.q!.toLowerCase()),
            ),
        )
        .sort((a, b) => b.inserted_at.localeCompare(a.inserted_at)),
    );
  }
}

class SummaryLookup {
  summaries = new Map<string, InstructorSummary>();
  calls: string[][] = [];

  set(n: number, overrides: Partial<InstructorSummary> = {}): void {
    this.summaries.set(idOf(n), {
      stage: 'live',
      onboardingComplete: false,
      certifications: [],
      trainers: [],
      ...overrides,
    });
  }

  stages(): never {
    throw new Error('the export reads summaries');
  }

  summariesFor(ids: readonly string[]): Map<string, InstructorSummary> {
    return new Map(
      ids.flatMap((id) => {
        const summary = this.summaries.get(id);
        return summary ? [[id, summary] as const] : [];
      }),
    );
  }
}

function startExportApp(
  repo: Pick<
    AdminRepository,
    'listInstructors' | 'listAllInstructors' | 'listInstructorIdsAtLocation'
  >,
  goLive: Pick<GoLiveService, 'stages' | 'summaries'>,
) {
  const audit = recordingAudit();
  return {
    audit,
    app: startAdminApp(
      Test.createTestingModule({
        controllers: [AdminController],
        providers: [
          { provide: SeasonsService, useValue: {} },
          AdminService,
          { provide: AdminRepository, useValue: repo },
          { provide: InstructorsService, useValue: {} },
          { provide: MailerService, useValue: {} },
          { provide: DocumentOnboardingService, useValue: {} },
          { provide: BIO_TRANSLATOR, useValue: {} },
          { provide: AuditService, useValue: audit },
          { provide: GoLiveService, useValue: goLive },
        ],
      }),
    ),
  };
}

async function build(count = 0) {
  const repo = new InMemoryInstructors();
  const lookup = new SummaryLookup();
  repo.rows = Array.from({ length: count }, (_, i) => makeRow(i + 1));
  for (let n = 1; n <= count; n++) {
    lookup.set(n);
  }
  const { app, audit } = startExportApp(repo, {
    stages: () => lookup.stages(),
    summaries: (ids) => {
      lookup.calls.push([...ids]);
      return Promise.resolve(lookup.summariesFor(ids));
    },
  });
  return { app: await app, audit, repo, lookup };
}

const csvLines = (res: request.Response) =>
  (res.text.startsWith('\uFEFF') ? res.text.slice(1) : res.text).split('\r\n');
const emailsOf = (res: request.Response) =>
  csvLines(res)
    .slice(1, -1)
    .map((line) => line.split(',')[1]);

describe('GET /admin/instructors/export.csv', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  const download = (query = '') =>
    http().get(`${EXPORT}${query}`).set('Authorization', admin);

  afterEach(async () => {
    await ctx.app.close();
  });

  it('needs an admin JWT and records only the guard failure without one', async () => {
    ctx = await build(2);
    await http().get(EXPORT).expect(401);
    await http().get(EXPORT).set('Authorization', INSTRUCTOR_AUTH).expect(403);
    expect(ctx.repo.calls).toEqual([]);
    expect(ctx.repo.locationCalls).toEqual([]);
    expect(ctx.audit.entries.map((e) => e.action)).toEqual([
      'auth.admin_guard_failure',
    ]);
  });

  it('is routed ahead of instructors/:id and served as a CSV attachment', async () => {
    ctx = await build(1);
    const res = await download().expect(200);

    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="instructors-${torontoToday()}.csv"`,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text.startsWith(`\uFEFF${HEADER}\r\n`)).toBe(true);
  });

  it('exports every instructor, newest first, by legal name with an empty phone', async () => {
    ctx = await build(4);
    ctx.repo.rows[0] = makeRow(1, { date_of_birth: '1990-04-05' });
    ctx.repo.rows[2] = makeRow(3, { first_name: null, last_name: ' ' });
    ctx.lookup.set(2, {
      certifications: [
        { org: 'csia', track: 'regular', level: 3, is_partial: true },
      ],
      trainers: [{ discipline: 'ski', trainer_level: 2 }],
    });
    ctx.repo.locations.set(
      'teaching_location.moonstone',
      new Set([idOf(1), idOf(2)]),
    );
    ctx.repo.locations.set('teaching_location.other', new Set([idOf(4)]));

    const res = await download().expect(200);

    expect(csvLines(res)).toEqual([
      HEADER,
      'Coach 4,coach4@example.com,,,,FALSE',
      'Nick 3,coach3@example.com,,,,FALSE',
      'Coach 2,coach2@example.com,,,CSIA Level 3 Partial; CSIA Level 2 Trainer,TRUE',
      'Coach 1,coach1@example.com,,1990-04-05,,TRUE',
      '',
    ]);
    expect(res.text).not.toContain('教练');
    expect(ctx.repo.calls).toEqual([{}]);
    expect(ctx.repo.locationCalls).toEqual(['teaching_location.moonstone']);
  });

  it('records one instructor.export audit row with the filters and counts, without personal data', async () => {
    ctx = await build(4);
    ctx.lookup.set(4, { stage: 'in_review' });
    ctx.repo.rows[3] = makeRow(4, {
      last_name: '王',
      date_of_birth: '1990-04-05',
    });

    await download(
      '?stage=in_review,live&onboarding=incomplete&active=true&q=coach&calendarConnected=true',
    )
      .set('User-Agent', 'export-test')
      .expect(200);

    expect(ctx.audit.entries).toEqual([
      {
        action: 'instructor.export',
        actor: { userId: ADMIN_ID, role: 'admin', userAgent: 'export-test' },
        targetType: 'instructor',
        targetId: null,
        metadata: {
          columns: [
            'Name',
            'Email',
            'Phone',
            'Date of Birth',
            'Certifications',
            'MSLM Podium Pass Holder',
          ],
          filters: {
            status: null,
            active: true,
            calendarConnected: true,
            search: true,
            stages: ['in_review', 'live'],
            onboarding: 'incomplete',
          },
          rowCount: 2,
          nonAsciiNames: 1,
        },
      },
    ]);
    expect(JSON.stringify(ctx.audit.entries)).not.toMatch(
      /@example\.com|Coach|coach|Nick|王|1990/,
    );
  });

  it('counts names with non-ASCII characters in a header and the audit row, and still exports them', async () => {
    ctx = await build(3);
    ctx.repo.rows = [
      makeRow(3, { first_name: '小明', last_name: '王' }),
      makeRow(2, { first_name: 'José', last_name: 'Ruiz' }),
      makeRow(1, { display_name_en: '王' }),
    ];

    const res = await download().expect(200);

    expect(res.headers['x-export-non-ascii-names']).toBe('2');
    expect(emailsOf(res)).toHaveLength(3);
    expect(csvLines(res)[1]).toBe('小明 王,coach3@example.com,,,,FALSE');
    expect(ctx.audit.entries[0].metadata).toMatchObject({
      rowCount: 3,
      nonAsciiNames: 2,
    });
  });

  it('says 0 in the header when every name is ASCII', async () => {
    ctx = await build(2);
    const res = await download().expect(200);
    expect(res.headers['x-export-non-ascii-names']).toBe('0');
  });

  it('accepts every stage at once, repeated or comma-separated', async () => {
    ctx = await build(INSTRUCTOR_STAGES.length);
    INSTRUCTOR_STAGES.forEach((stage, i) => ctx.lookup.set(i + 1, { stage }));

    const csv = await download(`?stage=${INSTRUCTOR_STAGES.join(',')}`).expect(
      200,
    );
    const repeated = await download(
      `?${INSTRUCTOR_STAGES.map((s) => `stage=${s}`).join('&')}`,
    ).expect(200);

    expect(emailsOf(csv)).toHaveLength(INSTRUCTOR_STAGES.length);
    expect(repeated.text).toBe(csv.text);
  });

  it.each(INSTRUCTOR_STAGES)(
    'exports only the %s instructors for that stage',
    async (stage) => {
      ctx = await build(INSTRUCTOR_STAGES.length);
      INSTRUCTOR_STAGES.forEach((s, i) => ctx.lookup.set(i + 1, { stage: s }));

      const res = await download(`?stage=${stage}`).expect(200);

      expect(emailsOf(res)).toEqual([
        `coach${INSTRUCTOR_STAGES.indexOf(stage) + 1}@example.com`,
      ]);
    },
  );

  it('narrows by stage', async () => {
    ctx = await build(6);
    const stages: InstructorStage[] = [
      'pending',
      'live',
      'deactivated',
      'going_live',
      'live',
      'rejected',
    ];
    stages.forEach((stage, i) => ctx.lookup.set(i + 1, { stage }));

    const res = await download('?stage=live&stage=rejected').expect(200);

    expect(emailsOf(res)).toEqual([
      'coach6@example.com',
      'coach5@example.com',
      'coach2@example.com',
    ]);
  });

  it('splits instructors into onboarding complete and incomplete with nothing left over', async () => {
    ctx = await build(5);
    ctx.lookup.set(2, { onboardingComplete: true });
    ctx.lookup.set(4, { onboardingComplete: true, stage: 'going_live' });
    ctx.lookup.summaries.delete(idOf(5));

    const complete = emailsOf(await download('?onboarding=complete'));
    const incomplete = emailsOf(await download('?onboarding=incomplete'));
    const all = emailsOf(await download());

    expect(complete).toEqual(['coach4@example.com', 'coach2@example.com']);
    expect(incomplete).toEqual([
      'coach5@example.com',
      'coach3@example.com',
      'coach1@example.com',
    ]);
    expect([...complete, ...incomplete].sort()).toEqual([...all].sort());
  });

  it('combines onboarding with stage and the row filters', async () => {
    ctx = await build(6);
    ctx.lookup.set(1, { onboardingComplete: true, stage: 'live' });
    ctx.lookup.set(2, { onboardingComplete: true, stage: 'going_live' });
    ctx.lookup.set(4, { onboardingComplete: true, stage: 'live' });
    ctx.lookup.set(6, { onboardingComplete: false, stage: 'live' });

    const res = await download(
      '?onboarding=complete&stage=live&calendarConnected=true&status=approved',
    ).expect(200);

    expect(emailsOf(res)).toEqual(['coach4@example.com']);
    expect(ctx.repo.calls).toEqual([
      { status: 'approved', calendarConnected: true },
    ]);
  });

  it.each([
    'onboarding=done',
    'onboarding=',
    'stage=held',
    'status=live',
    'active=yes',
    'page=1',
    'limit=10',
  ])('rejects %s with 400 and audits nothing', async (query) => {
    ctx = await build(1);
    await download(`?${query}`).expect(400);
    expect(ctx.repo.calls).toEqual([]);
    expect(ctx.audit.entries).toEqual([]);
  });
});

describe('GET /admin/instructors?onboarding=', () => {
  it('filters the list with the same rule, before paging, with the filtered total', async () => {
    const ctx = await build(5);
    ctx.lookup.set(1, { onboardingComplete: true });
    ctx.lookup.set(3, { onboardingComplete: true });
    ctx.lookup.set(5, { onboardingComplete: true });

    const res = await request(ctx.app.getHttpServer())
      .get('/admin/instructors?onboarding=complete&page=1&limit=2')
      .set('Authorization', admin)
      .expect(200);

    expect(
      (res.body as AdminInstructorListRecord[]).map((r) => r.email),
    ).toEqual(['coach5@example.com', 'coach3@example.com']);
    expect(res.headers['x-total-count']).toBe('3');
    await ctx.app.close();
  });
});

describe('GET /admin/instructors/export.csv over a row-capped PostgREST', () => {
  it('exports every instructor past the response cap', async () => {
    const count = POSTGREST_MAX_ROWS + 1;
    const capped = cappedSupabase({
      instructors: Array.from({ length: count }, (_, i) => makeRow(i + 1)),
    });
    const { app } = startExportApp(
      new SupabaseAdminRepository(capped.client as never),
      {
        stages: () => Promise.reject(new Error('unused')),
        summaries: (ids) =>
          Promise.resolve(
            new Map(
              ids.map((id) => [
                id,
                {
                  stage: 'live',
                  onboardingComplete: true,
                  certifications: [],
                  trainers: [],
                },
              ]),
            ),
          ),
      },
    );
    const server = await app;

    const res = await request(server.getHttpServer())
      .get(`${EXPORT}?onboarding=complete`)
      .set('Authorization', admin)
      .expect(200);

    expect(emailsOf(res)).toHaveLength(count);
    expect(capped.requests).toEqual(
      expect.arrayContaining([
        { table: 'instructors', range: [0, 999] },
        { table: 'instructors', range: [1000, 1999] },
        { table: 'instructors_teaching_locations', range: [0, 999] },
      ]),
    );
    expect(capped.requests).toHaveLength(3);
    await server.close();
  });
});

describe('onboarding=complete against the instructor checklist', () => {
  const CSIA_3: SyncCertRow = {
    org: 'csia',
    track: 'regular',
    level: 3,
    is_partial: false,
  };

  it('exports exactly the instructors whose checklist is complete', async () => {
    const sync = new InMemorySyncRepository();
    const goLive = goLiveFor(sync);
    const repo = new InMemoryInstructors();
    const today = torontoToday();
    const inDays = (days: number) => {
      const date = new Date(`${today}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    let next = 0;
    const add = ({
      approval_status = 'approved' as const,
      is_active = true,
      certifications = [CSIA_3],
    }: {
      approval_status?: 'pending' | 'approved' | 'rejected';
      is_active?: boolean;
      certifications?: SyncCertRow[];
    } = {}) => {
      const n = ++next;
      const id = idOf(n);
      repo.rows.push(makeRow(n, { approval_status, is_active }));
      sync.snapshots.set(
        id,
        readySnapshotOf({
          instructor: { id, approval_status, is_active },
          certifications,
        }),
      );
      goLive.subjects.seedInstructor({
        id,
        auth_user_id: authIdOf(n),
        approval_status,
        is_active,
      });
      goLive.subjects.certifications.set(
        id,
        certifications.map(({ org, track, level }) => ({ org, track, level })),
      );
      return id;
    };
    const verified = (id: string) =>
      goLive.subjects.uploads.push(verifiedUpload('csia', 'regular', 3, id));
    const upload = (id: string, overrides: { valid_until: string } | object) =>
      goLive.subjects.uploads.push(
        certificationUploadRow({ instructor_id: id, ...overrides }),
      );
    const document = (
      id: string,
      status: 'assigned' | 'completed',
      required = true,
    ) => {
      const template = goLive.templates.seed({ status: 'live', required });
      goLive.assignments.seed({
        template_id: template.id,
        subject_id: id,
        status,
      });
    };

    const signedAndVerified = add();
    verified(signedAndVerified);
    document(signedAndVerified, 'completed');

    const unsigned = add();
    verified(unsigned);
    document(unsigned, 'assigned');

    const optionalUnsigned = add();
    verified(optionalUnsigned);
    document(optionalUnsigned, 'completed');
    document(optionalUnsigned, 'assigned', false);

    const expiringCard = add();
    upload(expiringCard, { valid_until: inDays(10) });

    const expiredCard = add();
    upload(expiredCard, { valid_until: inDays(-1) });

    const pendingCard = add();
    upload(pendingCard, { review_status: 'pending' });

    add();

    add({ certifications: [] });

    const pending = add({ approval_status: 'pending' });
    verified(pending);

    const rejected = add({ approval_status: 'rejected' });
    verified(rejected);

    const deactivated = add({ is_active: false });
    verified(deactivated);
    document(deactivated, 'completed');

    const { app } = startExportApp(repo, goLive.service);
    const server = await app;
    const exported = async (onboarding: string) =>
      emailsOf(
        await request(server.getHttpServer())
          .get(`${EXPORT}?onboarding=${onboarding}`)
          .set('Authorization', admin)
          .expect(200),
      ).sort();

    const checklistComplete: string[] = [];
    const checklistIncomplete: string[] = [];
    for (const row of repo.rows) {
      const { complete } = await goLive.documents.checklist(
        row.auth_user_id,
        today,
      );
      (complete ? checklistComplete : checklistIncomplete).push(row.email);
    }

    expect(await exported('complete')).toEqual(checklistComplete.sort());
    expect(await exported('incomplete')).toEqual(checklistIncomplete.sort());
    expect(checklistComplete.sort()).toEqual(
      [1, 3, 4, 8].map((n) => `coach${n}@example.com`),
    );
    await server.close();
  });
});
