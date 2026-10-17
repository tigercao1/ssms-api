import { recordingPayrollSupabase } from '../../test/helpers/payroll-fakes';
import { DatabaseError } from '../database/db-result';
import { PGRST_RANGE_NOT_SATISFIABLE } from '../database/pagination';
import {
  ADMIN_INSURANCE_RECORD_COLUMNS,
  INSURANCE_INSTRUCTOR_COLUMNS,
  INSURANCE_PAGE_SIZE,
  INSURANCE_RECORD_COLUMNS,
  SupabaseLessonInsuranceRepository,
} from './lesson-insurance.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const KEY = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ok = (data: unknown) => ({ data, error: null });
const fail = { data: null, error: { message: 'boom', code: '23503' } };

describe('SupabaseLessonInsuranceRepository', () => {
  it('loads the instructor by auth user', async () => {
    const row = { id: ID, approval_status: 'approved' };
    const { client, calls } = recordingPayrollSupabase({
      instructors: ok(row),
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    await expect(repo.instructorByAuthUser('auth-1')).resolves.toEqual(row);
    expect(calls[0].ops).toEqual([
      ['select', INSURANCE_INSTRUCTOR_COLUMNS],
      ['eq', 'auth_user_id', 'auth-1'],
      ['maybeSingle'],
    ]);
  });

  it('loads the instructor by id', async () => {
    const row = { id: ID, approval_status: 'pending' };
    const { client, calls } = recordingPayrollSupabase({
      instructors: ok(row),
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    await expect(repo.instructorById(ID)).resolves.toEqual(row);
    expect(calls[0].ops).toEqual([
      ['select', INSURANCE_INSTRUCTOR_COLUMNS],
      ['eq', 'id', ID],
      ['maybeSingle'],
    ]);
  });

  it('registers through the plpgsql function and keeps its error code', async () => {
    const { client, calls } = recordingPayrollSupabase({
      'rpc:lesson_insurance_register': [
        ok({ outcome: 'created', id: ID }),
        ok(null),
        fail,
      ],
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    const input = {
      instructorId: ID,
      kind: 'lesson' as const,
      seasonKey: null,
      lessonDate: '2026-12-01',
      durationHours: 2,
      locationId: null,
      locationOther: 'Blue',
      students: [{ name: 'Ada', waiverConfirmed: true }],
      idempotencyKey: KEY,
      actor: 'auth-1',
    };
    await expect(repo.register(input)).resolves.toEqual({
      outcome: 'created',
      id: ID,
    });
    expect(calls[0].ops[0][1]).toEqual({
      p_instructor_id: ID,
      p_kind: 'lesson',
      p_season_key: null,
      p_lesson_date: '2026-12-01',
      p_duration_hours: 2,
      p_location_id: null,
      p_location_other: 'Blue',
      p_students: [{ name: 'Ada', waiverConfirmed: true }],
      p_top_up: false,
      p_idempotency_key: KEY,
      p_actor: 'auth-1',
    });
    await expect(repo.register(input)).rejects.toThrow('no result');
    await expect(repo.register(input)).rejects.toMatchObject({
      constructor: DatabaseError,
      code: '23503',
    });
  });

  it('finds a record with its instructor and location', async () => {
    const { client, calls } = recordingPayrollSupabase({
      lesson_insurance_records: ok({ id: ID }),
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    await expect(repo.findRecord(ID)).resolves.toEqual({ id: ID });
    expect(calls[0].ops).toEqual([
      ['select', ADMIN_INSURANCE_RECORD_COLUMNS, undefined],
      ['eq', 'id', ID],
      ['maybeSingle'],
    ]);
  });

  it('reads every page of an instructor season and of a whole season', async () => {
    const full = Array.from({ length: INSURANCE_PAGE_SIZE }, (_, i) => ({ i }));
    const { client, calls } = recordingPayrollSupabase({
      lesson_insurance_records: [ok(full), ok([{ i: -1 }]), ok(null)],
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    await expect(repo.recordsFor(ID, '2026/27')).resolves.toHaveLength(
      INSURANCE_PAGE_SIZE + 1,
    );
    expect(calls[0].ops).toEqual([
      ['select', INSURANCE_RECORD_COLUMNS, undefined],
      ['eq', 'season_key', '2026/27'],
      ['eq', 'instructor_id', ID],
      ['order', 'created_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['range', 0, INSURANCE_PAGE_SIZE - 1],
    ]);
    expect(calls[1].ops.at(-1)).toEqual([
      'range',
      INSURANCE_PAGE_SIZE,
      2 * INSURANCE_PAGE_SIZE - 1,
    ]);
    await expect(repo.seasonRecords('2026/27')).resolves.toEqual([]);
    expect(calls[2].ops[0]).toEqual([
      'select',
      ADMIN_INSURANCE_RECORD_COLUMNS,
      undefined,
    ]);
  });

  it('lists a filtered page newest first with the total, and counts past the end', async () => {
    const { client, calls } = recordingPayrollSupabase({
      lesson_insurance_records: [
        { data: [{ id: ID }], error: null, count: 7 },
        {
          data: null,
          error: { message: 'range', code: PGRST_RANGE_NOT_SATISFIABLE },
        },
        { data: null, error: null, count: 7 },
        { data: null, error: null, count: null },
      ],
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    const filter = {
      seasonKey: '2026/27',
      instructorId: ID,
      paymentStatus: 'paid' as const,
    };
    await expect(
      repo.listRecords(filter, { limit: 10, offset: 20 }),
    ).resolves.toEqual({ rows: [{ id: ID }], total: 7 });
    expect(calls[0].ops).toEqual([
      ['select', ADMIN_INSURANCE_RECORD_COLUMNS, { count: 'exact' }],
      ['eq', 'season_key', '2026/27'],
      ['eq', 'instructor_id', ID],
      ['eq', 'payment_status', 'paid'],
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: false }],
      ['range', 20, 29],
    ]);
    await expect(
      repo.listRecords({ seasonKey: '2026/27' }, { limit: 10, offset: 90 }),
    ).resolves.toEqual({ rows: [], total: 7 });
    expect(calls[2].ops[0]).toEqual([
      'select',
      'id',
      { count: 'exact', head: true },
    ]);
    await expect(
      repo.listRecords({ seasonKey: '2026/27' }, { limit: 10, offset: 0 }),
    ).resolves.toEqual({ rows: [], total: 0 });
  });

  it('updates only when the status still matches', async () => {
    const { client, calls } = recordingPayrollSupabase({
      lesson_insurance_records: [ok(null), fail],
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    await expect(
      repo.updateIfStatus(ID, 'unpaid', { payment_status: 'paid' }),
    ).resolves.toBeNull();
    expect(calls[0].ops).toEqual([
      ['update', { payment_status: 'paid' }],
      ['eq', 'id', ID],
      ['eq', 'payment_status', 'unpaid'],
      ['select', ADMIN_INSURANCE_RECORD_COLUMNS],
      ['maybeSingle'],
    ]);
    await expect(
      repo.updateIfStatus(ID, 'unpaid', { payment_status: 'paid' }),
    ).rejects.toThrow('update insurance record');
  });

  it('fails loudly on read errors', async () => {
    const { client } = recordingPayrollSupabase({
      instructors: fail,
      lesson_insurance_records: fail,
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    await expect(repo.instructorByAuthUser('x')).rejects.toThrow(
      'load instructor',
    );
    await expect(repo.findRecord(ID)).rejects.toThrow('load insurance record');
    await expect(repo.recordsFor(ID, '2026/27')).rejects.toThrow(
      'list insurance records',
    );
    await expect(
      repo.listRecords({ seasonKey: 'x' }, { limit: 1, offset: 0 }),
    ).rejects.toThrow('list insurance records');
  });
});
