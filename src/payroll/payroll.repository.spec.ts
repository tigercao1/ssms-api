import { recordingPayrollSupabase } from '../../test/helpers/payroll-fakes';
import { DatabaseError } from '../database/db-result';
import { PAY_RATE_COLUMNS } from '../lessons/pay-rates.repository';
import {
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
});
