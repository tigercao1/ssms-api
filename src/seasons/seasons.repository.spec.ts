import { recordingPayrollSupabase } from '../../test/helpers/payroll-fakes';
import { DatabaseError } from '../database/db-result';
import {
  SEASON_COLUMNS,
  SupabaseSeasonsRepository,
} from './seasons.repository';

const ROW = { key: '2026/27', starts_on: '2026-11-01', ends_on: '2027-04-30' };
const ok = (data: unknown) => ({ data, error: null });
const fail = { data: null, error: { message: 'boom', code: '23P01' } };

describe('SupabaseSeasonsRepository', () => {
  it('lists seasons newest first', async () => {
    const { client, calls } = recordingPayrollSupabase({ seasons: ok([ROW]) });
    const repo = new SupabaseSeasonsRepository(client);
    await expect(repo.list()).resolves.toEqual([ROW]);
    expect(calls[0].ops).toEqual([
      ['select', SEASON_COLUMNS],
      ['order', 'starts_on', { ascending: false }],
    ]);
  });

  it('returns an empty list when there is no data', async () => {
    const { client } = recordingPayrollSupabase({ seasons: ok(null) });
    await expect(new SupabaseSeasonsRepository(client).list()).resolves.toEqual(
      [],
    );
  });

  it('inserts, updates and deletes by key', async () => {
    const { client, calls } = recordingPayrollSupabase({
      seasons: [ok(ROW), ok(ROW), ok(null)],
    });
    const repo = new SupabaseSeasonsRepository(client);
    await expect(repo.insert(ROW)).resolves.toEqual(ROW);
    await expect(
      repo.update('2026/27', { ends_on: '2027-04-30' }),
    ).resolves.toEqual(ROW);
    await expect(repo.delete('2026/27')).resolves.toBeNull();
    expect(calls.map((c) => c.ops[0][0])).toEqual([
      'insert',
      'update',
      'delete',
    ]);
    expect(calls[1].ops).toContainEqual(['eq', 'key', '2026/27']);
    expect(calls[2].ops).toContainEqual(['eq', 'key', '2026/27']);
  });

  it('keeps the Postgres error code', async () => {
    const { client } = recordingPayrollSupabase({ seasons: fail });
    const repo = new SupabaseSeasonsRepository(client);
    for (const call of [
      () => repo.list(),
      () => repo.insert(ROW),
      () => repo.update('2026/27', {}),
      () => repo.delete('2026/27'),
    ]) {
      await expect(call()).rejects.toMatchObject({
        constructor: DatabaseError,
        code: '23P01',
      });
    }
  });

  it('sums the references across every table that uses a season', async () => {
    const { client, calls } = recordingPayrollSupabase({
      document_templates: { data: null, error: null, count: 2 },
      document_assignments: { data: null, error: null, count: null },
      instructor_invites: { data: null, error: null, count: 3 },
    });
    const repo = new SupabaseSeasonsRepository(client);
    await expect(repo.referenceCount('2026/27')).resolves.toBe(5);
    expect(calls.map((c) => c.target)).toEqual([
      'document_templates',
      'document_assignments',
      'instructor_invites',
    ]);
    expect(calls[0].ops).toEqual([
      ['select', 'season', { count: 'exact', head: true }],
      ['eq', 'season', '2026/27'],
    ]);
  });

  it('fails the count loudly', async () => {
    const { client } = recordingPayrollSupabase({ instructor_invites: fail });
    await expect(
      new SupabaseSeasonsRepository(client).referenceCount('2026/27'),
    ).rejects.toThrow('count instructor_invites using season');
  });
});
