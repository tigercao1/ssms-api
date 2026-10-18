import { recordingPayrollSupabase } from '../../test/helpers/payroll-fakes';
import { DatabaseError } from '../database/db-result';
import { PGRST_RANGE_NOT_SATISFIABLE } from '../database/pagination';
import {
  ADMIN_INSURANCE_RECORD_COLUMNS,
  ADMIN_INSURANCE_REQUEST_COLUMNS,
  INSURANCE_INSTRUCTOR_COLUMNS,
  INSURANCE_PAGE_SIZE,
  INSURANCE_RECORD_COLUMNS,
  INSURANCE_REQUEST_COLUMNS,
  INSURANCE_SUMMARY_INSTRUCTOR_COLUMNS,
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

  it('reads every page of approved instructors', async () => {
    const full = Array.from({ length: INSURANCE_PAGE_SIZE }, (_, i) => ({ i }));
    const { client, calls } = recordingPayrollSupabase({
      instructors: [ok(full), ok(null), fail],
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    await expect(repo.approvedInstructors()).resolves.toHaveLength(
      INSURANCE_PAGE_SIZE,
    );
    expect(calls[0].ops).toEqual([
      ['select', INSURANCE_SUMMARY_INSTRUCTOR_COLUMNS],
      ['eq', 'approval_status', 'approved'],
      ['order', 'id', { ascending: true }],
      ['range', 0, INSURANCE_PAGE_SIZE - 1],
    ]);
    expect(calls[1].ops.at(-1)).toEqual([
      'range',
      INSURANCE_PAGE_SIZE,
      2 * INSURANCE_PAGE_SIZE - 1,
    ]);
    await expect(repo.approvedInstructors()).rejects.toThrow(
      'list approved instructors',
    );
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

  it('grants a season pass through one plpgsql call and keeps its error code', async () => {
    const { client, calls } = recordingPayrollSupabase({
      'rpc:lesson_insurance_admin_grant_pass': [
        ok({ outcome: 'created', id: ID }),
        ok(null),
        fail,
      ],
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    const input = {
      instructorId: ID,
      seasonKey: '2026/27',
      actor: 'auth-1',
      idempotencyKey: KEY,
      paidOn: '2026-10-14',
      paidNote: 'e-transfer',
    };
    await expect(repo.grantSeasonPass(input)).resolves.toEqual({
      outcome: 'created',
      id: ID,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].ops[0][1]).toEqual({
      p_instructor_id: ID,
      p_season_key: '2026/27',
      p_actor: 'auth-1',
      p_idempotency_key: KEY,
      p_paid_on: '2026-10-14',
      p_paid_note: 'e-transfer',
    });
    await expect(repo.grantSeasonPass(input)).rejects.toThrow('no result');
    await expect(repo.grantSeasonPass(input)).rejects.toMatchObject({
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

  it('submits a request through one plpgsql call and keeps its error code', async () => {
    const { client, calls } = recordingPayrollSupabase({
      'rpc:lesson_insurance_submit_request': [
        ok({ outcome: 'created', id: ID }),
        ok(null),
        fail,
      ],
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    const input = {
      instructorId: ID,
      seasonKey: null,
      lessons: [
        {
          lessonDate: '2026-12-01',
          durationHours: 1,
          locationId: null,
          locationOther: null,
          students: [{ name: 'Ada', waiverConfirmed: true }],
        },
      ],
      idempotencyKey: KEY,
      actor: 'auth-1',
    };
    await expect(repo.submitRequest(input)).resolves.toEqual({
      outcome: 'created',
      id: ID,
    });
    expect(calls[0].ops).toEqual([
      [
        'args',
        {
          p_instructor_id: ID,
          p_season_key: null,
          p_lessons: input.lessons,
          p_idempotency_key: KEY,
          p_actor: 'auth-1',
        },
      ],
    ]);
    await expect(repo.submitRequest(input)).rejects.toThrow('no result');
    await expect(repo.submitRequest(input)).rejects.toMatchObject({
      constructor: DatabaseError,
      code: '23503',
    });
  });

  it('transitions a request through one plpgsql call', async () => {
    const { client, calls } = recordingPayrollSupabase({
      'rpc:lesson_insurance_request_transition': [
        ok({
          outcome: 'updated',
          from: 'unpaid',
          to: 'paid',
          request: { id: ID },
        }),
        ok(null),
        fail,
      ],
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    const input = {
      requestId: ID,
      action: 'mark_paid' as const,
      actor: 'admin-1',
      paidOn: '2026-10-15',
      note: 'e-transfer',
      reason: null,
    };
    await expect(repo.transitionRequest(input)).resolves.toEqual({
      outcome: 'updated',
      from: 'unpaid',
      to: 'paid',
      request: { id: ID },
    });
    expect(calls[0].ops).toEqual([
      [
        'args',
        {
          p_request_id: ID,
          p_action: 'mark_paid',
          p_actor: 'admin-1',
          p_paid_on: '2026-10-15',
          p_note: 'e-transfer',
          p_reason: null,
        },
      ],
    ]);
    await expect(repo.transitionRequest(input)).rejects.toThrow('no result');
    await expect(repo.transitionRequest(input)).rejects.toThrow(
      'update insurance request',
    );
  });

  it('finds a request with its lessons and instructor', async () => {
    const { client, calls } = recordingPayrollSupabase({
      lesson_insurance_requests: [ok({ id: ID }), fail],
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    await expect(repo.findRequest(ID)).resolves.toEqual({ id: ID });
    expect(calls[0].ops).toEqual([
      ['select', ADMIN_INSURANCE_REQUEST_COLUMNS],
      ['eq', 'id', ID],
      ['maybeSingle'],
    ]);
    expect(ADMIN_INSURANCE_REQUEST_COLUMNS).toContain(
      'lessons:lesson_insurance_records!lesson_insurance_records_request_id_fkey(',
    );
    expect(ADMIN_INSURANCE_REQUEST_COLUMNS).toContain(
      'instructor:instructors!lesson_insurance_requests_instructor_id_fkey(',
    );
    await expect(repo.findRequest(ID)).rejects.toThrow(
      'load insurance request',
    );
  });

  it('reads every page of an instructor season of requests, newest first', async () => {
    const full = Array.from({ length: INSURANCE_PAGE_SIZE }, (_, i) => ({ i }));
    const { client, calls } = recordingPayrollSupabase({
      lesson_insurance_requests: [ok(full), ok([])],
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    await expect(repo.requestsFor(ID, '2026/27')).resolves.toHaveLength(
      INSURANCE_PAGE_SIZE,
    );
    expect(calls[0].ops).toEqual([
      ['select', INSURANCE_REQUEST_COLUMNS, undefined],
      ['eq', 'season_key', '2026/27'],
      ['eq', 'instructor_id', ID],
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: false }],
      ['range', 0, INSURANCE_PAGE_SIZE - 1],
    ]);
  });

  it('lists a filtered page of requests with the total', async () => {
    const { client, calls } = recordingPayrollSupabase({
      lesson_insurance_requests: [
        { data: [{ id: ID }], error: null, count: 3 },
        {
          data: null,
          error: { message: 'range', code: PGRST_RANGE_NOT_SATISFIABLE },
        },
        { data: null, error: null, count: 3 },
        fail,
      ],
    });
    const repo = new SupabaseLessonInsuranceRepository(client);
    await expect(
      repo.listRequests(
        { seasonKey: '2026/27', paymentStatus: 'unpaid' },
        { limit: 10, offset: 0 },
      ),
    ).resolves.toEqual({ rows: [{ id: ID }], total: 3 });
    expect(calls[0].ops).toEqual([
      ['select', ADMIN_INSURANCE_REQUEST_COLUMNS, { count: 'exact' }],
      ['eq', 'season_key', '2026/27'],
      ['eq', 'payment_status', 'unpaid'],
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: false }],
      ['range', 0, 9],
    ]);
    await expect(
      repo.listRequests({ seasonKey: '2026/27' }, { limit: 10, offset: 50 }),
    ).resolves.toEqual({ rows: [], total: 3 });
    expect(calls[2].target).toBe('lesson_insurance_requests');
    await expect(
      repo.listRequests({ seasonKey: '2026/27' }, { limit: 10, offset: 0 }),
    ).rejects.toThrow('list insurance requests');
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
