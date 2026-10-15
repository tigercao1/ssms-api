import { recordingPayrollSupabase } from '../../test/helpers/payroll-fakes';
import { DatabaseError } from '../database/db-result';
import { PAY_RATE_COLUMNS } from '../lessons/pay-rates.repository';
import {
  CLASS_ID_CHUNK,
  INSTRUCTOR_APPROVAL_COLUMNS,
  INSTRUCTOR_CLASS_COLUMNS,
  INSTRUCTOR_LINE_COLUMNS,
  PAGE_SIZE,
  PAYROLL_CLASS_COLUMNS,
  PAYROLL_LINE_COLUMNS,
  PAYROLL_PERIOD_COLUMNS,
  SupabasePayrollRepository,
} from './payroll.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const ok = (data: unknown) => ({ data, error: null });
const fail = { data: null, error: { message: 'boom', code: '55000' } };

describe('SupabasePayrollRepository', () => {
  it('loads the settings row and fails loudly when it is missing', async () => {
    const settings = { anchor_date: '2025-12-15', period_days: 14 };
    const { client, calls } = recordingPayrollSupabase({
      payroll_settings: [ok(settings), ok(null)],
    });
    const repo = new SupabasePayrollRepository(client);
    await expect(repo.settings()).resolves.toEqual(settings);
    await expect(repo.settings()).rejects.toThrow('no row returned');
    expect(calls[0].ops).toContainEqual(['eq', 'id', true]);
  });

  it('calls the anchor, finalize and reopen functions', async () => {
    const { client, calls } = recordingPayrollSupabase();
    const repo = new SupabasePayrollRepository(client);
    await repo.setAnchor('2025-12-22', ID);
    await repo.finalize(ID, [], ID);
    await repo.reopen(ID);
    expect(calls.map((c) => [c.target, c.ops[0][1]])).toEqual([
      ['rpc:payroll_set_anchor', { p_anchor: '2025-12-22', p_actor: ID }],
      ['rpc:payroll_finalize', { p_period_id: ID, p_lines: [], p_actor: ID }],
      ['rpc:payroll_reopen', { p_period_id: ID }],
    ]);
  });

  it('keeps the Postgres error code from the functions', async () => {
    const { client } = recordingPayrollSupabase({
      'rpc:payroll_finalize': fail,
      'rpc:payroll_reopen': fail,
      'rpc:payroll_set_anchor': fail,
    });
    const repo = new SupabasePayrollRepository(client);
    for (const call of [
      () => repo.finalize(ID, [], null),
      () => repo.reopen(ID),
      () => repo.setAnchor('2025-12-22', null),
    ]) {
      await expect(call()).rejects.toMatchObject({
        constructor: DatabaseError,
        code: '55000',
      });
    }
  });

  it('upserts periods without overwriting and reads them back in order', async () => {
    const periods = [{ starts_on: '2025-12-15', ends_on: '2025-12-28' }];
    const { client, calls } = recordingPayrollSupabase({
      payroll_periods: [ok(null), ok([{ id: ID }])],
    });
    await expect(
      new SupabasePayrollRepository(client).ensurePeriods(periods),
    ).resolves.toEqual([{ id: ID }]);
    expect(calls[0].ops).toEqual([
      ['upsert', periods, { onConflict: 'starts_on', ignoreDuplicates: true }],
    ]);
    expect(calls[1].ops).toEqual([
      ['select', PAYROLL_PERIOD_COLUMNS],
      ['in', 'starts_on', ['2025-12-15']],
      ['order', 'starts_on', { ascending: true }],
    ]);
  });

  it('finds a period and checks for finalized ones', async () => {
    const { client, calls } = recordingPayrollSupabase({
      payroll_periods: [ok({ id: ID }), ok(null), ok([{ id: ID }]), ok([])],
    });
    const repo = new SupabasePayrollRepository(client);
    await expect(repo.findPeriod(ID)).resolves.toEqual({ id: ID });
    await expect(repo.findPeriod(ID)).resolves.toBeNull();
    await expect(repo.hasFinalizedPeriod()).resolves.toBe(true);
    await expect(repo.hasFinalizedPeriod()).resolves.toBe(false);
    expect(calls[2].ops).toContainEqual(['eq', 'status', 'finalized']);
  });

  it('pages through non-cancelled classes in the window', async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: `c${i}` }));
    const { client, calls } = recordingPayrollSupabase({
      classes: [ok(full), ok([{ id: 'last' }])],
    });
    const rows = await new SupabasePayrollRepository(client).classesBetween(
      '2025-12-15T05:00:00.000Z',
      '2025-12-29T05:00:00.000Z',
    );
    expect(rows).toHaveLength(PAGE_SIZE + 1);
    expect(calls[0].ops).toEqual([
      ['select', PAYROLL_CLASS_COLUMNS],
      ['gte', 'starts_at', '2025-12-15T05:00:00.000Z'],
      ['lt', 'starts_at', '2025-12-29T05:00:00.000Z'],
      ['neq', 'status', 'cancelled'],
      ['order', 'starts_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['range', 0, PAGE_SIZE - 1],
    ]);
    expect(calls[1].ops).toContainEqual([
      'range',
      PAGE_SIZE,
      2 * PAGE_SIZE - 1,
    ]);
  });

  it('loads rates only for the lesson types in play', async () => {
    const { client, calls } = recordingPayrollSupabase({
      pay_rates: ok([{ id: ID }]),
    });
    const repo = new SupabasePayrollRepository(client);
    await expect(repo.ratesFor([])).resolves.toEqual([]);
    await expect(repo.ratesFor([ID])).resolves.toEqual([{ id: ID }]);
    expect(calls).toEqual([
      {
        target: 'pay_rates',
        ops: [
          ['select', PAY_RATE_COLUMNS],
          ['in', 'lesson_type_id', [ID]],
        ],
      },
    ]);
  });

  it('finds classes already snapshotted by another period in chunks', async () => {
    const ids = Array.from({ length: CLASS_ID_CHUNK + 1 }, (_, i) => `c${i}`);
    const { client, calls } = recordingPayrollSupabase({
      payroll_lines: [ok([{ class_id: 'c1' }]), ok(null)],
    });
    const repo = new SupabasePayrollRepository(client);
    await expect(repo.classesPaidElsewhere(ID, ids)).resolves.toEqual(['c1']);
    await expect(repo.classesPaidElsewhere(ID, [])).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0].ops).toEqual([
      ['select', 'class_id'],
      ['eq', 'kind', 'class'],
      ['neq', 'period_id', ID],
      ['in', 'class_id', ids.slice(0, CLASS_ID_CHUNK)],
    ]);
    expect(calls[1].ops).toContainEqual([
      'in',
      'class_id',
      [ids[CLASS_ID_CHUNK]],
    ]);
  });

  it('reads, adds and deletes lines', async () => {
    const { client, calls } = recordingPayrollSupabase({
      payroll_lines: [ok(null), ok({ id: ID }), ok(null), ok({ id: ID })],
    });
    const repo = new SupabasePayrollRepository(client);
    await expect(repo.lines(ID)).resolves.toEqual([]);
    const insert = {
      period_id: ID,
      instructor_id: ID,
      kind: 'adjustment' as const,
      description: 'Bonus',
      currency: 'CAD',
      amount: 10,
      created_by: null,
    };
    await expect(repo.insertAdjustment(insert)).resolves.toEqual({ id: ID });
    await expect(repo.deleteAdjustment(ID, ID)).resolves.toBeNull();
    await expect(repo.deleteAdjustment(ID, ID)).resolves.toEqual({ id: ID });
    expect(calls[0].ops[0]).toEqual(['select', PAYROLL_LINE_COLUMNS]);
    expect(calls[1].ops[0]).toEqual(['insert', insert]);
    expect(calls[2].ops).toEqual(
      expect.arrayContaining([
        ['delete'],
        ['eq', 'period_id', ID],
        ['eq', 'kind', 'adjustment'],
      ]),
    );
  });

  it('fails when an insert returns no row and surfaces query errors', async () => {
    const { client } = recordingPayrollSupabase({
      payroll_lines: [ok(null), fail],
      payroll_periods: fail,
      classes: fail,
      pay_rates: fail,
    });
    const repo = new SupabasePayrollRepository(client);
    await expect(
      repo.insertAdjustment({
        period_id: ID,
        instructor_id: ID,
        kind: 'adjustment',
        description: 'x',
        currency: 'CAD',
        amount: 1,
        created_by: null,
      }),
    ).rejects.toThrow('no row returned');
    await expect(repo.lines(ID)).rejects.toThrow('boom');
    await expect(repo.findPeriod(ID)).rejects.toThrow('boom');
    await expect(repo.classesBetween('a', 'b')).rejects.toThrow('boom');
    await expect(repo.ratesFor([ID])).rejects.toThrow('boom');
  });

  it('reads one instructor’s profile, classes, lines, periods and paid classes', async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: `r${i}` }));
    const ids = Array.from({ length: CLASS_ID_CHUNK + 1 }, (_, i) => `c${i}`);
    const { client, calls } = recordingPayrollSupabase({
      instructors: [ok({ id: ID, approval_status: 'approved' }), ok(null)],
      classes: [ok(full), ok([{ id: 'last' }])],
      payroll_lines: [
        ok([{ id: ID }]),
        ok([{ class_id: 'c1', period_id: ID }]),
        ok(null),
      ],
      payroll_periods: [ok([{ id: ID }]), ok(null)],
    });
    const repo = new SupabasePayrollRepository(client);
    await expect(repo.instructorByAuthUser(ID)).resolves.toEqual({
      id: ID,
      approval_status: 'approved',
    });
    await expect(repo.instructorByAuthUser(ID)).resolves.toBeNull();
    await expect(repo.classesForInstructor(ID)).resolves.toHaveLength(
      PAGE_SIZE + 1,
    );
    await expect(repo.linesForInstructor(ID)).resolves.toEqual([{ id: ID }]);
    await expect(repo.classLinePeriods(ids)).resolves.toEqual([
      { class_id: 'c1', period_id: ID },
    ]);
    await expect(repo.classLinePeriods([])).resolves.toEqual([]);
    await expect(
      repo.periodsStartingOn(['2025-12-29', ...ids]),
    ).resolves.toEqual([{ id: ID }]);
    await expect(repo.periodsStartingOn([])).resolves.toEqual([]);
    expect(calls.map((c) => [c.target, c.ops])).toEqual([
      [
        'instructors',
        [
          ['select', INSTRUCTOR_APPROVAL_COLUMNS],
          ['eq', 'auth_user_id', ID],
          ['maybeSingle'],
        ],
      ],
      ['instructors', expect.any(Array)],
      [
        'classes',
        [
          ['select', INSTRUCTOR_CLASS_COLUMNS],
          ['eq', 'instructor_id', ID],
          ['neq', 'status', 'cancelled'],
          ['order', 'starts_at', { ascending: true }],
          ['order', 'id', { ascending: true }],
          ['range', 0, PAGE_SIZE - 1],
        ],
      ],
      [
        'classes',
        expect.arrayContaining([['range', PAGE_SIZE, 2 * PAGE_SIZE - 1]]),
      ],
      [
        'payroll_lines',
        [
          ['select', INSTRUCTOR_LINE_COLUMNS],
          ['eq', 'instructor_id', ID],
          ['order', 'created_at', { ascending: true }],
          ['order', 'id', { ascending: true }],
          ['range', 0, PAGE_SIZE - 1],
        ],
      ],
      [
        'payroll_lines',
        [
          ['select', 'class_id, period_id'],
          ['eq', 'kind', 'class'],
          ['in', 'class_id', ids.slice(0, CLASS_ID_CHUNK)],
        ],
      ],
      [
        'payroll_lines',
        expect.arrayContaining([['in', 'class_id', [ids[CLASS_ID_CHUNK]]]]),
      ],
      [
        'payroll_periods',
        [
          ['select', PAYROLL_PERIOD_COLUMNS],
          [
            'in',
            'starts_on',
            ['2025-12-29', ...ids.slice(0, CLASS_ID_CHUNK - 1)],
          ],
        ],
      ],
      ['payroll_periods', expect.any(Array)],
    ]);
  });

  it('surfaces errors from the instructor reads', async () => {
    const { client } = recordingPayrollSupabase({
      instructors: fail,
      classes: fail,
      payroll_lines: fail,
      payroll_periods: fail,
    });
    const repo = new SupabasePayrollRepository(client);
    await expect(repo.instructorByAuthUser(ID)).rejects.toThrow('boom');
    await expect(repo.classesForInstructor(ID)).rejects.toThrow('boom');
    await expect(repo.linesForInstructor(ID)).rejects.toThrow('boom');
    await expect(repo.classLinePeriods([ID])).rejects.toThrow('boom');
    await expect(repo.periodsStartingOn(['2025-12-29'])).rejects.toThrow(
      'boom',
    );
  });
});
