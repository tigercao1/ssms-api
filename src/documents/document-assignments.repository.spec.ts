import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import {
  DOCUMENT_ASSIGNMENT_COLUMNS,
  SupabaseDocumentAssignmentsRepository,
} from './document-assignments.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';

describe('SupabaseDocumentAssignmentsRepository.updateIfStatus', () => {
  it('updates only rows in the given statuses and returns null when none match', async () => {
    const row = { id: ID, status: 'completed' };
    const { client, queries } = recordingSupabase({
      document_assignments: [
        { data: row, error: null },
        { data: null, error: null },
        { data: null, error: { message: 'boom' } },
      ],
    });
    const repo = new SupabaseDocumentAssignmentsRepository(client);
    const patch = { status: 'completed' as const };
    await expect(
      repo.updateIfStatus(ID, ['assigned', 'viewed'], patch),
    ).resolves.toEqual(row);
    await expect(repo.updateIfStatus(ID, ['assigned'], patch)).resolves.toBe(
      null,
    );
    await expect(repo.updateIfStatus(ID, ['assigned'], patch)).rejects.toThrow(
      'update document assignment',
    );
    expect(queries[0].ops).toEqual([
      ['update', patch],
      ['eq', 'id', ID],
      ['in', 'status', ['assigned', 'viewed']],
      ['select', DOCUMENT_ASSIGNMENT_COLUMNS],
      ['maybeSingle'],
    ]);
  });
});
