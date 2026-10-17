import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { DatabaseError } from '../database/db-result';
import { SupabaseDailyReminderRunsRepository } from './daily-reminder-runs.repository';

const fail = { data: null, error: { message: 'boom' } };

describe('SupabaseDailyReminderRunsRepository', () => {
  it('starts the day through the RPC and returns its token, or null when it may not run', async () => {
    const { client, queries } = recordingSupabase({
      'rpc:try_start_daily_reminders': [
        { data: 'token-1', error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseDailyReminderRunsRepository(client);
    await expect(repo.tryStart('2026-10-17', 1800)).resolves.toBe('token-1');
    await expect(repo.tryStart('2026-10-17', 1800)).resolves.toBeNull();
    expect(queries[0].ops).toEqual([
      ['rpc', { p_day: '2026-10-17', p_lease_seconds: 1800 }],
    ]);
  });

  it('records the finish with each part and reports whether the lease still held', async () => {
    const { client, queries } = recordingSupabase({
      'rpc:finish_daily_reminders': [
        { data: true, error: null },
        { data: false, error: null },
      ],
    });
    const repo = new SupabaseDailyReminderRunsRepository(client);
    const outcome = {
      documents: { sent: 2, error: null },
      certifications: { sent: null, error: 'db down' },
      invites: { sent: 0, error: null },
    };
    await expect(repo.finish('token-1', outcome)).resolves.toBe(true);
    await expect(repo.finish('token-2', outcome)).resolves.toBe(false);
    expect(queries[0].ops).toEqual([
      [
        'rpc',
        {
          p_token: 'token-1',
          p_documents_sent: 2,
          p_documents_error: null,
          p_certifications_sent: null,
          p_certifications_error: 'db down',
          p_invites_sent: 0,
          p_invites_error: null,
        },
      ],
    ]);
  });

  it('raises database errors', async () => {
    const { client } = recordingSupabase({
      'rpc:try_start_daily_reminders': fail,
      'rpc:finish_daily_reminders': fail,
    });
    const repo = new SupabaseDailyReminderRunsRepository(client);
    await expect(repo.tryStart('2026-10-17', 1800)).rejects.toThrow(
      DatabaseError,
    );
    await expect(
      repo.finish('t', {
        documents: { sent: 0, error: null },
        certifications: { sent: 0, error: null },
        invites: { sent: 0, error: null },
      }),
    ).rejects.toThrow('Failed to record daily reminders: boom');
  });
});
