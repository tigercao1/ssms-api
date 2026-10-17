import { randomUUID } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { Request } from 'express';
import type { App } from 'supertest/types';
import { SupabaseAuthGuard } from '../../src/auth/supabase-auth.guard';
import {
  DatabaseError,
  PG_FOREIGN_KEY_VIOLATION,
} from '../../src/database/db-result';
import type { PageRequest, RowPage } from '../../src/database/pagination';
import {
  type AdminInsuranceRecordRow,
  type GrantSeasonPassInput,
  type InsuranceInstructorRow,
  type InsuranceRecordFilter,
  type InsuranceRecordPatch,
  type InsuranceRecordRow,
  type InsuranceSummaryInstructorRow,
  LessonInsuranceRepository,
  type PaymentStatus,
  type RegisterInput,
  type RegisterOutcome,
} from '../../src/insurance/lesson-insurance.repository';
import type { SeasonRow } from '../../src/seasons/seasons.repository';

export const INSURANCE_ADMIN_ID = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';
export const ADA_AUTH = 'Bearer jwt-ada';
export const BO_AUTH = 'Bearer jwt-bo';
export const UNVERIFIED_AUTH = 'Bearer jwt-unverified';
export const ADMIN_AUTH = 'Bearer jwt-admin';
export const ADA_USER = 'a0000000-0000-4000-8000-0000000000ad';
export const BO_USER = 'b0000000-0000-4000-8000-0000000000b0';
export const ADA_INSTRUCTOR = 'a1000000-0000-4000-8000-0000000000ad';
export const BO_INSTRUCTOR = 'b1000000-0000-4000-8000-0000000000b0';
export const HILL_ID = 'c1000000-0000-4000-8000-00000000c001';
const CAP = 40000;

const USERS: Record<string, string> = {
  admin: INSURANCE_ADMIN_ID,
  ada: ADA_USER,
  bo: BO_USER,
  unverified: ADA_USER,
};

class FakeInsuranceJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const who = /^Bearer jwt-(\w+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!who || !USERS[who]) {
      throw new UnauthorizedException();
    }
    (req as Request & { user: unknown }).user = {
      sub: USERS[who],
      email: `${who}@example.com`,
      email_confirmed_at: who === 'unverified' ? null : '2026-01-01T00:00:00Z',
      app_metadata: who === 'admin' ? { role: 'admin' } : {},
    };
    return true;
  }
}

export async function startInsuranceApp(
  builder: TestingModuleBuilder,
): Promise<INestApplication<App>> {
  const moduleRef = await builder
    .overrideGuard(SupabaseAuthGuard)
    .useClass(FakeInsuranceJwtGuard)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0, '127.0.0.1');
  return app;
}

interface FakeInstructor extends InsuranceInstructorRow {
  authUserId: string;
  display_name_en: string;
  display_name_zh: string | null;
  email: string;
}

export class InMemoryLessonInsuranceRepository extends LessonInsuranceRepository {
  readonly rows = new Map<string, AdminInsuranceRecordRow>();
  readonly instructors = new Map<string, FakeInstructor>();
  readonly idempotency = new Map<string, string>();
  readonly counters = new Map<string, number>();
  readonly locations = new Map<string, string>([[HILL_ID, 'CI Hill']]);
  readonly registerCalls: RegisterInput[] = [];
  readonly grantCalls: GrantSeasonPassInput[] = [];
  grantFaultAfterInsert: Error | null = null;
  private tick = 0;

  constructor(
    private readonly seasons: () => SeasonRow[],
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  addInstructor(
    authUserId: string,
    id: string,
    name: string,
    approval: InsuranceInstructorRow['approval_status'] = 'approved',
    nameZh: string | null = null,
  ): void {
    this.instructors.set(id, {
      id,
      authUserId,
      approval_status: approval,
      display_name_en: name,
      display_name_zh: nameZh,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
    });
  }

  instructorByAuthUser(
    authUserId: string,
  ): Promise<InsuranceInstructorRow | null> {
    const found = [...this.instructors.values()].find(
      (i) => i.authUserId === authUserId,
    );
    return Promise.resolve(
      found ? { id: found.id, approval_status: found.approval_status } : null,
    );
  }

  instructorById(id: string): Promise<InsuranceInstructorRow | null> {
    const found = this.instructors.get(id);
    return Promise.resolve(
      found ? { id: found.id, approval_status: found.approval_status } : null,
    );
  }

  approvedInstructors(): Promise<InsuranceSummaryInstructorRow[]> {
    return Promise.resolve(
      [...this.instructors.values()]
        .filter((i) => i.approval_status === 'approved')
        .map(({ id, display_name_en, display_name_zh, email }) => ({
          id,
          display_name_en,
          display_name_zh,
          email,
        })),
    );
  }

  register(input: RegisterInput): Promise<RegisterOutcome> {
    this.registerCalls.push(input);
    const idemKey = `${input.instructorId}|${input.idempotencyKey}`;
    const existing = this.idempotency.get(idemKey);
    if (existing) {
      return Promise.resolve({ outcome: 'existing', id: existing });
    }
    const season =
      input.kind === 'lesson'
        ? this.seasons().find(
            (s) =>
              s.starts_on <= input.lessonDate! &&
              input.lessonDate! <= s.ends_on,
          )
        : this.seasons().find((s) => s.key === input.seasonKey);
    if (!season) {
      return Promise.resolve({ outcome: 'no_season' });
    }
    if (input.locationId && !this.locations.has(input.locationId)) {
      return Promise.reject(
        new DatabaseError('register', PG_FOREIGN_KEY_VIOLATION, 'location'),
      );
    }
    const mine = [...this.rows.values()].filter(
      (r) =>
        r.instructor_id === input.instructorId &&
        r.season_key === season.key &&
        r.payment_status !== 'voided',
    );
    const owed = mine.reduce((sum, r) => sum + r.amount_cents, 0);
    let list: number;
    let amount: number;
    let coverage: InsuranceRecordRow['coverage'];
    let status: PaymentStatus = 'unpaid';
    if (input.kind === 'lesson') {
      list = 1000 * input.durationHours! * Math.min(input.students!.length, 4);
      if (owed >= CAP) {
        amount = 0;
        status = 'not_required';
        coverage = mine.some((r) => r.kind === 'season_pass')
          ? 'season_pass'
          : 'capped';
      } else if (owed + list >= CAP) {
        amount = CAP - owed;
        coverage = 'cap_top_up';
      } else {
        amount = list;
        coverage = 'per_lesson';
      }
    } else {
      if (mine.some((r) => r.kind === 'season_pass')) {
        return Promise.resolve({
          outcome: 'already_has_pass',
          season_key: season.key,
          owed_cents: owed,
        });
      }
      if (owed >= CAP) {
        return Promise.resolve({
          outcome: 'already_covered',
          season_key: season.key,
          owed_cents: owed,
        });
      }
      list = CAP;
      amount = CAP - owed;
      coverage = null;
    }
    const now = new Date(this.now().getTime() + this.tick++);
    const day = now
      .toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
      .replace(/-/g, '');
    const no = (this.counters.get(day) ?? 0) + 1;
    this.counters.set(day, no);
    const instructor = this.instructors.get(input.instructorId)!;
    const lesson = input.kind === 'lesson';
    const row: AdminInsuranceRecordRow = {
      id: randomUUID(),
      instructor_id: input.instructorId,
      season_key: season.key,
      kind: input.kind,
      lesson_date: lesson ? input.lessonDate : null,
      duration_hours: lesson ? input.durationHours : null,
      location_id: lesson ? input.locationId : null,
      location_other: lesson ? input.locationOther : null,
      students: lesson ? input.students : null,
      student_count: lesson ? input.students!.length : null,
      list_cents: list,
      amount_cents: amount,
      coverage,
      payment_status: status,
      paid_on: null,
      paid_note: null,
      paid_by: null,
      voided_at: null,
      voided_reason: null,
      voided_by: null,
      voided_from_status: null,
      record_no: `INS-${day}-${String(no).padStart(4, '0')}`,
      created_by: input.actor,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      location:
        lesson && input.locationId
          ? { name: this.locations.get(input.locationId)! }
          : null,
      instructor: {
        display_name_en: instructor.display_name_en,
        display_name_zh: instructor.display_name_zh,
        email: instructor.email,
      },
    };
    this.rows.set(row.id, row);
    this.idempotency.set(idemKey, row.id);
    return Promise.resolve({ outcome: 'created', id: row.id });
  }

  async grantSeasonPass(input: GrantSeasonPassInput): Promise<RegisterOutcome> {
    this.grantCalls.push(input);
    const rows = new Map(
      [...this.rows].map(([id, row]) => [id, structuredClone(row)]),
    );
    const idempotency = new Map(this.idempotency);
    const counters = new Map(this.counters);
    const tick = this.tick;
    try {
      const outcome = await this.register({
        instructorId: input.instructorId,
        kind: 'season_pass',
        seasonKey: input.seasonKey,
        lessonDate: null,
        durationHours: null,
        locationId: null,
        locationOther: null,
        students: null,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
      });
      if (outcome.outcome === 'created') {
        if (this.grantFaultAfterInsert) {
          throw this.grantFaultAfterInsert;
        }
        if (input.paidOn) {
          Object.assign(this.rows.get(outcome.id)!, {
            payment_status: 'paid',
            paid_on: input.paidOn,
            paid_note: input.paidNote,
            paid_by: input.actor,
          });
        }
      }
      return outcome;
    } catch (error) {
      this.restore(this.rows, rows);
      this.restore(this.idempotency, idempotency);
      this.restore(this.counters, counters);
      this.tick = tick;
      throw error;
    }
  }

  private restore<K, V>(target: Map<K, V>, snapshot: Map<K, V>): void {
    target.clear();
    snapshot.forEach((value, key) => target.set(key, value));
  }

  findRecord(id: string): Promise<AdminInsuranceRecordRow | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : null);
  }

  recordsFor(
    instructorId: string,
    seasonKey: string,
  ): Promise<InsuranceRecordRow[]> {
    return Promise.resolve(
      this.matching({ seasonKey, instructorId }).map((r) => {
        const copy: Partial<AdminInsuranceRecordRow> = structuredClone(r);
        delete copy.instructor;
        return copy as InsuranceRecordRow;
      }),
    );
  }

  seasonRecords(seasonKey: string): Promise<AdminInsuranceRecordRow[]> {
    return Promise.resolve(
      this.matching({ seasonKey }).map((r) => structuredClone(r)),
    );
  }

  readonly listCalls: { filter: InsuranceRecordFilter; page: PageRequest }[] =
    [];

  listRecords(
    filter: InsuranceRecordFilter,
    page: PageRequest,
  ): Promise<RowPage<AdminInsuranceRecordRow>> {
    this.listCalls.push({ filter, page });
    const all = this.matching(filter).sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
    );
    return Promise.resolve({
      rows: all
        .slice(page.offset, page.offset + page.limit)
        .map((r) => structuredClone(r)),
      total: all.length,
    });
  }

  updateIfStatus(
    id: string,
    from: PaymentStatus,
    patch: InsuranceRecordPatch,
  ): Promise<AdminInsuranceRecordRow | null> {
    const row = this.rows.get(id);
    if (!row || row.payment_status !== from) {
      return Promise.resolve(null);
    }
    const next = { ...row, ...patch };
    const keepsPayment =
      next.payment_status === 'paid' ||
      (next.payment_status === 'voided' && next.voided_from_status === 'paid');
    if (
      keepsPayment !== (next.paid_on !== null) ||
      (next.paid_on === null &&
        (next.paid_note !== null || next.paid_by !== null))
    ) {
      return Promise.reject(
        new Error(
          'violates check constraint lesson_insurance_records_paid_check',
        ),
      );
    }
    Object.assign(row, patch, { updated_at: this.now().toISOString() });
    return Promise.resolve(structuredClone(row));
  }

  private matching(filter: InsuranceRecordFilter): AdminInsuranceRecordRow[] {
    return [...this.rows.values()].filter(
      (r) =>
        r.season_key === filter.seasonKey &&
        (!filter.instructorId || r.instructor_id === filter.instructorId) &&
        (!filter.paymentStatus || r.payment_status === filter.paymentStatus),
    );
  }
}

export const NOW = '2026-10-15T16:00:00Z';
