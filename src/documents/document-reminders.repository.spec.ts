import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import {
  DOCUMENT_ASSIGNMENT_COLUMNS,
  SupabaseDocumentAssignmentsRepository,
} from './document-assignments.repository';

describe('SupabaseDocumentAssignmentsRepository.listDueForReminder', () => {
  it('selects open assignments assigned and last reminded before the cutoff, oldest first', async () => {
    const row = { id: 'a1' };
    const { client, queries } = recordingSupabase({
      document_assignments: [
        { data: [row], error: null },
        { data: null, error: null },
        { data: null, error: { message: 'boom' } },
      ],
    });
    const repo = new SupabaseDocumentAssignmentsRepository(client);
    const cutoff = new Date('2026-10-06T15:00:00.000Z');

    await expect(
      repo.listDueForReminder('instructor', cutoff),
    ).resolves.toEqual([row]);
    await expect(
      repo.listDueForReminder('instructor', cutoff),
    ).resolves.toEqual([]);
    await expect(repo.listDueForReminder('customer', cutoff)).rejects.toThrow(
      'list document assignments due for a reminder',
    );
    expect(queries[0].ops).toEqual([
      ['select', DOCUMENT_ASSIGNMENT_COLUMNS],
      ['eq', 'subject_type', 'instructor'],
      ['in', 'status', ['assigned', 'viewed']],
      ['lt', 'assigned_at', '2026-10-06T15:00:00.000Z'],
      [
        'or',
        'reminder_sent_at.is.null,reminder_sent_at.lt.2026-10-06T15:00:00.000Z',
      ],
      ['order', 'assigned_at', { ascending: true }],
    ]);
  });
});

describe('SupabaseDocumentAssignmentsRepository reminder claims', () => {
  const cutoff = new Date('2026-10-11T16:00:00.000Z');
  const at = new Date('2026-10-17T15:00:00.000Z');

  it('claims through the RPC and returns the claimed ids', async () => {
    const { client, queries } = recordingSupabase({
      'rpc:claim_document_reminders': [
        { data: ['a1'], error: null },
        { data: null, error: null },
        { data: null, error: { message: 'boom' } },
      ],
    });
    const repo = new SupabaseDocumentAssignmentsRepository(client);

    await expect(
      repo.claimForReminder(['a1', 'a2'], cutoff, at),
    ).resolves.toEqual(['a1']);
    await expect(repo.claimForReminder(['a1'], cutoff, at)).resolves.toEqual(
      [],
    );
    await expect(repo.claimForReminder(['a1'], cutoff, at)).rejects.toThrow(
      'claim document reminders',
    );
    expect(queries[0].ops).toEqual([
      [
        'rpc',
        {
          p_ids: ['a1', 'a2'],
          p_cutoff: '2026-10-11T16:00:00.000Z',
          p_at: '2026-10-17T15:00:00.000Z',
        },
      ],
    ]);
  });

  it('releases only the claims taken at the given time', async () => {
    const { client, queries } = recordingSupabase({
      document_assignments: [
        { data: null, error: null },
        { data: null, error: { message: 'boom' } },
      ],
    });
    const repo = new SupabaseDocumentAssignmentsRepository(client);

    await repo.releaseReminderClaim(['a1', 'a2'], at);
    await expect(repo.releaseReminderClaim(['a1'], at)).rejects.toThrow(
      'release document reminder claims',
    );
    expect(queries[0].ops).toEqual([
      ['update', { reminder_claimed_at: null }],
      ['in', 'id', ['a1', 'a2']],
      ['eq', 'reminder_claimed_at', '2026-10-17T15:00:00.000Z'],
    ]);
  });
});
