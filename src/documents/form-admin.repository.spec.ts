import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { SupabaseFormAdminRepository } from './form-admin.repository';

describe('SupabaseFormAdminRepository signature links', () => {
  it('moves a signature in one update that only matches a completed signature still filed under the old customer', async () => {
    const { client, queries } = recordingSupabase({
      document_assignments: [
        { data: { id: 'a1' }, error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseFormAdminRepository(client);

    await expect(repo.relinkCustomerSignature('a1', 'c1', 'c2')).resolves.toBe(
      true,
    );
    await expect(repo.relinkCustomerSignature('a1', 'c1', 'c2')).resolves.toBe(
      false,
    );
    expect(queries[0].ops).toEqual([
      ['update', { subject_id: 'c2' }],
      ['eq', 'id', 'a1'],
      ['eq', 'subject_type', 'customer'],
      ['eq', 'subject_id', 'c1'],
      ['eq', 'status', 'completed'],
      ['select', 'id'],
      ['maybeSingle'],
    ]);
  });

  it("lists a customer's completed signatures newest first in the lookup row shape", async () => {
    const { client, queries } = recordingSupabase({
      document_assignments: {
        data: [
          {
            id: 'a1',
            template_id: 't1',
            language: 'zh',
            form_version: 3,
            completed_at: '2026-11-02T00:00:00Z',
            signed_key: 'signed/a1.pdf',
            template: { title_en: 'Waiver', title_zh: '免责', kind: 'form' },
          },
        ],
        error: null,
      },
    });

    await expect(
      new SupabaseFormAdminRepository(client).customerSignatures('c1'),
    ).resolves.toEqual([
      {
        assignment_id: 'a1',
        template_id: 't1',
        title_en: 'Waiver',
        title_zh: '免责',
        kind: 'form',
        language: 'zh',
        form_version: 3,
        signed_at: '2026-11-02T00:00:00Z',
        has_signed_copy: true,
      },
    ]);
    expect(queries[0].ops.slice(1)).toEqual([
      ['eq', 'subject_type', 'customer'],
      ['eq', 'subject_id', 'c1'],
      ['eq', 'status', 'completed'],
      ['order', 'completed_at', { ascending: false }],
    ]);
  });
});
