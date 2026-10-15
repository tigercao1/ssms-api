import {
  DatabaseError,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from '../../src/database/db-result';
import type { PageRequest, RowPage } from '../../src/database/pagination';
import type { GoogleCalendar } from '../../src/google/google.types';
import type { GoogleCalendarClient } from '../../src/google/google-calendar.client';
import {
  type ClassFilter,
  ClassesRepository,
  type ClassRow,
  MAX_CLASSES_PER_LIST,
} from '../../src/lessons/classes.repository';
import {
  type CalendarInstructorRow,
  type InstructorCalendarInput,
  type InstructorCalendarRow,
  InstructorCalendarsRepository,
} from '../../src/lessons/instructor-calendars.repository';
import {
  type LessonTypeRow,
  LessonTypesRepository,
  type LessonTypeWrite,
} from '../../src/lessons/lesson-types.repository';
import {
  type PayRateFilter,
  type PayRateInsert,
  type PayRatePatch,
  type PayRateRow,
  PayRatesRepository,
} from '../../src/lessons/pay-rates.repository';

export const EDDIE_ID = '0b6f4c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';
export const ERIC_ID = '1c7a5d2f-3b4e-4f6a-9b0c-1d2e3f4a5b6c';

let sequence = 0;
export const nextId = () =>
  `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

class Clock {
  private value = Date.parse('2026-10-10T00:00:00.000Z');
  tick(): string {
    this.value += 1000;
    return new Date(this.value).toISOString();
  }
}

export interface FakeResult {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

export interface RecordedQuery {
  table: string;
  ops: [string, ...unknown[]][];
}

export function recordingSupabase(
  results: Record<string, FakeResult | FakeResult[]> = {},
) {
  const queries: RecordedQuery[] = [];
  const next = (key: string): FakeResult => {
    const entry = results[key];
    if (Array.isArray(entry)) {
      return entry.shift() ?? { data: null, error: null };
    }
    return entry ?? { data: null, error: null };
  };
  const builderFor = (key: string, query: RecordedQuery) => {
    const builder: Record<string, unknown> = {
      then: (
        resolve: (r: FakeResult) => unknown,
        reject: (e: unknown) => void,
      ) => Promise.resolve(next(key)).then(resolve, reject),
    };
    for (const op of [
      'select',
      'eq',
      'in',
      'is',
      'not',
      'or',
      'ilike',
      'gte',
      'lt',
      'limit',
      'range',
      'order',
      'insert',
      'update',
      'upsert',
      'delete',
      'single',
      'maybeSingle',
    ]) {
      builder[op] = (...args: unknown[]) => {
        query.ops.push([op, ...args]);
        return builder;
      };
    }
    return builder;
  };
  const client = {
    from(table: string) {
      const query: RecordedQuery = { table, ops: [] };
      queries.push(query);
      return builderFor(table, query);
    },
    rpc(name: string, args?: unknown) {
      const query: RecordedQuery = {
        table: `rpc:${name}`,
        ops: [['rpc', args]],
      };
      queries.push(query);
      return Promise.resolve(next(`rpc:${name}`));
    },
  };
  return { client: client as never, queries };
}

export class InMemoryClassesRepository extends ClassesRepository {
  rows: ClassRow[] = [];
  filters: ClassFilter[] = [];
  pages: (PageRequest | undefined)[] = [];

  list(filter: ClassFilter, page?: PageRequest): Promise<RowPage<ClassRow>> {
    this.filters.push(filter);
    this.pages.push(page);
    const matches = this.rows
      .filter(
        (r) =>
          (!filter.from || r.starts_at >= filter.from) &&
          (!filter.to || r.starts_at < filter.to) &&
          (!filter.instructorId || r.instructor_id === filter.instructorId),
      )
      .sort(
        (a, b) =>
          a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id),
      );
    return Promise.resolve({
      rows: page
        ? matches.slice(page.offset, page.offset + page.limit)
        : matches.slice(0, MAX_CLASSES_PER_LIST),
      total: matches.length,
    });
  }
}

export function classRow(overrides: Partial<ClassRow> = {}): ClassRow {
  return {
    id: nextId(),
    instructor_id: EDDIE_ID,
    lesson_type_id: null,
    location_id: null,
    starts_at: '2026-12-12T15:00:00.000Z',
    ends_at: '2026-12-12T16:00:00.000Z',
    status: 'scheduled',
    source: 'ssms',
    google_calendar_id: null,
    google_event_id: null,
    google_event_seq: 0,
    google_sync_status: 'ok',
    google_sync_error: null,
    google_sync_attempts: 0,
    google_synced_at: null,
    notes: null,
    created_at: '2026-10-10T00:00:00.000Z',
    updated_at: '2026-10-10T00:00:00.000Z',
    instructor: { display_name_en: 'Eddie', display_name_zh: '艾迪' },
    location: null,
    lesson_type: null,
    participants: [],
    ...overrides,
  };
}

export const calendarInstructors: CalendarInstructorRow[] = [
  {
    id: EDDIE_ID,
    email: 'eddie@example.com',
    display_name_en: 'Eddie Chen',
    display_name_zh: '陈艾迪',
    approval_status: 'approved',
    is_active: true,
  },
  {
    id: ERIC_ID,
    email: 'eric@example.com',
    display_name_en: 'Eric Wang',
    display_name_zh: null,
    approval_status: 'approved',
    is_active: true,
  },
];

export class InMemoryInstructorCalendarsRepository extends InstructorCalendarsRepository {
  instructors: CalendarInstructorRow[] = calendarInstructors.map((i) => ({
    ...i,
  }));
  rows = new Map<
    string,
    InstructorCalendarRow & { updated_by: string | null }
  >();
  private clock = new Clock();

  instructorExists(id: string): Promise<boolean> {
    return Promise.resolve(this.instructors.some((i) => i.id === id));
  }

  listInstructors(): Promise<CalendarInstructorRow[]> {
    return Promise.resolve(this.instructors.map((i) => ({ ...i })));
  }

  list(): Promise<InstructorCalendarRow[]> {
    return Promise.resolve([...this.rows.values()].map((r) => ({ ...r })));
  }

  find(instructorId: string): Promise<InstructorCalendarRow | null> {
    const row = this.rows.get(instructorId);
    return Promise.resolve(row ? { ...row } : null);
  }

  upsert(
    instructorId: string,
    input: InstructorCalendarInput,
    userId: string | null,
  ): Promise<InstructorCalendarRow> {
    this.assertCalendarFree(instructorId, input.google_calendar_id);
    const row = {
      instructor_id: instructorId,
      ...input,
      updated_at: this.clock.tick(),
      updated_by: userId,
    };
    this.rows.set(instructorId, row);
    return Promise.resolve({ ...row });
  }

  insertIfAbsent(
    instructorId: string,
    input: InstructorCalendarInput,
    userId: string | null,
  ): Promise<boolean> {
    if (this.rows.has(instructorId)) {
      return Promise.resolve(false);
    }
    try {
      this.assertCalendarFree(instructorId, input.google_calendar_id);
    } catch {
      return Promise.resolve(false);
    }
    this.rows.set(instructorId, {
      instructor_id: instructorId,
      ...input,
      updated_at: this.clock.tick(),
      updated_by: userId,
    });
    return Promise.resolve(true);
  }

  remove(instructorId: string): Promise<void> {
    this.rows.delete(instructorId);
    return Promise.resolve();
  }

  private assertCalendarFree(instructorId: string, calendarId: string): void {
    for (const row of this.rows.values()) {
      if (
        row.google_calendar_id === calendarId &&
        row.instructor_id !== instructorId
      ) {
        throw new DatabaseError(
          'save instructor calendar',
          PG_UNIQUE_VIOLATION,
          'duplicate key value violates unique constraint',
        );
      }
    }
  }
}

export function fakeGoogle(
  options: {
    connected?: boolean;
    calendars?: GoogleCalendar[];
    error?: Error;
  } = {},
) {
  const isConnected = jest.fn(() => Promise.resolve(options.connected ?? true));
  const listCalendars = jest.fn(() =>
    options.error
      ? Promise.reject(options.error)
      : Promise.resolve(options.calendars ?? []),
  );
  return {
    client: { isConnected, listCalendars } as unknown as GoogleCalendarClient,
    isConnected,
    listCalendars,
  };
}

export class InMemoryLessonTypesRepository extends LessonTypesRepository {
  rows: LessonTypeRow[] = [];
  private clock = new Clock();

  list(filter: { active?: boolean }): Promise<LessonTypeRow[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) => filter.active === undefined || r.active === filter.active,
        )
        .sort(
          (a, b) =>
            a.sort_order - b.sort_order || a.name_en.localeCompare(b.name_en),
        )
        .map((r) => ({ ...r })),
    );
  }

  findById(id: string): Promise<LessonTypeRow | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(row ? { ...row } : null);
  }

  insert(
    input: LessonTypeWrite & Pick<LessonTypeRow, 'name_en' | 'duration_min'>,
  ): Promise<LessonTypeRow> {
    this.assertUniqueName(input.name_en, null);
    const now = this.clock.tick();
    const row: LessonTypeRow = {
      id: nextId(),
      name_zh: null,
      group_size: null,
      is_promo: false,
      active: true,
      sort_order: 0,
      ...input,
      created_at: now,
      updated_at: now,
    };
    this.rows.push(row);
    return Promise.resolve({ ...row });
  }

  update(id: string, patch: LessonTypeWrite): Promise<LessonTypeRow | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) {
      return Promise.resolve(null);
    }
    if (patch.name_en !== undefined) {
      this.assertUniqueName(patch.name_en, id);
    }
    Object.assign(row, patch, { updated_at: this.clock.tick() });
    return Promise.resolve({ ...row });
  }

  seed(overrides: Partial<LessonTypeRow> = {}): LessonTypeRow {
    const now = this.clock.tick();
    const row: LessonTypeRow = {
      id: nextId(),
      name_en: 'Private 2h',
      name_zh: '1对1滑雪课 - 2小时',
      group_size: 1,
      duration_min: 120,
      is_promo: false,
      active: true,
      sort_order: 0,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  private assertUniqueName(name: string, exceptId: string | null): void {
    const key = name.trim().toLowerCase();
    if (
      this.rows.some(
        (r) => r.id !== exceptId && r.name_en.trim().toLowerCase() === key,
      )
    ) {
      throw new DatabaseError(
        'save lesson type',
        PG_UNIQUE_VIOLATION,
        'duplicate key value violates unique constraint "lesson_types_name_en_key"',
      );
    }
  }
}

export class InMemoryPayRatesRepository extends PayRatesRepository {
  rows: PayRateRow[] = [];
  lessonTypeIds = new Set<string>();
  instructorIds = new Set([EDDIE_ID, ERIC_ID]);
  private clock = new Clock();

  list(filter: PayRateFilter): Promise<PayRateRow[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            (!filter.lessonTypeId ||
              r.lesson_type_id === filter.lessonTypeId) &&
            (!filter.instructorId || r.instructor_id === filter.instructorId) &&
            (filter.scope !== 'default' || r.instructor_id === null) &&
            (filter.scope !== 'override' || r.instructor_id !== null),
        )
        .map((r) => ({ ...r })),
    );
  }

  findById(id: string): Promise<PayRateRow | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(row ? { ...row } : null);
  }

  ratesFor(lessonTypeId: string, instructorId: string): Promise<PayRateRow[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            r.lesson_type_id === lessonTypeId &&
            (r.instructor_id === null || r.instructor_id === instructorId),
        )
        .map((r) => ({ ...r })),
    );
  }

  insert(input: PayRateInsert): Promise<PayRateRow> {
    if (!this.lessonTypeIds.has(input.lesson_type_id)) {
      throw this.fkError('lesson_type_id');
    }
    if (input.instructor_id && !this.instructorIds.has(input.instructor_id)) {
      throw this.fkError('instructor_id');
    }
    const now = this.clock.tick();
    const row: PayRateRow = {
      id: nextId(),
      lesson_type_id: input.lesson_type_id,
      instructor_id: input.instructor_id,
      hourly_rate: input.hourly_rate.toFixed(2),
      currency: input.currency ?? 'CAD',
      effective_from: input.effective_from,
      effective_to: input.effective_to,
      created_at: now,
      updated_at: now,
    };
    this.assertNoOverlap(row);
    this.rows.push(row);
    return Promise.resolve({ ...row });
  }

  update(id: string, patch: PayRatePatch): Promise<PayRateRow | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) {
      return Promise.resolve(null);
    }
    const next: PayRateRow = {
      ...row,
      ...patch,
      hourly_rate:
        patch.hourly_rate === undefined
          ? row.hourly_rate
          : patch.hourly_rate.toFixed(2),
      updated_at: this.clock.tick(),
    };
    this.assertNoOverlap(next);
    Object.assign(row, next);
    return Promise.resolve({ ...row });
  }

  private assertNoOverlap(candidate: PayRateRow): void {
    const end = (r: PayRateRow) => r.effective_to ?? '9999-12-31';
    const clash = this.rows.some(
      (r) =>
        r.id !== candidate.id &&
        r.lesson_type_id === candidate.lesson_type_id &&
        r.instructor_id === candidate.instructor_id &&
        r.effective_from <= end(candidate) &&
        candidate.effective_from <= end(r),
    );
    if (clash) {
      throw new DatabaseError(
        'save pay rate',
        PG_EXCLUSION_VIOLATION,
        'conflicting key value violates exclusion constraint "pay_rates_no_overlap"',
      );
    }
  }

  private fkError(column: string): DatabaseError {
    return new DatabaseError(
      'create pay rate',
      PG_FOREIGN_KEY_VIOLATION,
      `insert or update on table "pay_rates" violates foreign key constraint "pay_rates_${column}_fkey"`,
    );
  }
}
