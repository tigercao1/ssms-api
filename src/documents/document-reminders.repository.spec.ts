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
