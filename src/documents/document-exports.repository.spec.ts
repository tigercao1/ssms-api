import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import {
  DOCUMENT_EXPORT_COLUMNS,
  SupabaseDocumentExportsRepository,
} from './document-exports.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const fail = { data: null, error: { message: 'boom' } };
const ok = (data: unknown) => ({ data, error: null });

describe('SupabaseDocumentExportsRepository', () => {
  it('inserts, finds, lists and updates exports', async () => {
    const row = { id: ID };
    const { client, queries } = recordingSupabase({
      document_exports: [
        ok(row),
        ok(row),
        ok(null),
        ok([row]),
        ok(null),
        ok(row),
        ok(null),
        ok([row, row]),
        ok(null),
        ok([row]),
        ok(null),
      ],
    });
    const repo = new SupabaseDocumentExportsRepository(client);
    const input = {
      template_id: ID,
      season: null,
      assignment_ids: null,
      requested_by: ID,
      owner_id: 'm-1',
      heartbeat_at: 'now',
    };
    await expect(repo.insert(input)).resolves.toEqual(row);
    await expect(repo.findById(ID)).resolves.toEqual(row);
    await expect(repo.findById(ID)).resolves.toBeNull();
    await expect(repo.listForTemplate(ID, 10)).resolves.toEqual([row]);
    await expect(repo.listForTemplate(ID, 10)).resolves.toEqual([]);
    await expect(
      repo.updateIfStatus(ID, ['queued'], { status: 'running' }),
    ).resolves.toEqual(row);
    await expect(
      repo.updateIfStatus(ID, ['queued'], { status: 'running' }),
    ).resolves.toBeNull();
    await expect(repo.failStale('cutoff', 'restart', 'now')).resolves.toBe(2);
    await expect(repo.failStale('cutoff', 'restart', 'now')).resolves.toBe(0);
    await expect(repo.listExpired('now')).resolves.toEqual([row]);
    await expect(repo.listExpired('now')).resolves.toEqual([]);

    expect(queries[0].ops).toEqual([
      ['insert', input],
      ['select', DOCUMENT_EXPORT_COLUMNS],
      ['single'],
    ]);
    expect(queries[3].ops).toEqual([
      ['select', DOCUMENT_EXPORT_COLUMNS],
      ['eq', 'template_id', ID],
      ['order', 'inserted_at', { ascending: false }],
      ['limit', 10],
    ]);
    expect(queries[5].ops).toEqual([
      ['update', { status: 'running' }],
      ['eq', 'id', ID],
      ['in', 'status', ['queued']],
      ['select', DOCUMENT_EXPORT_COLUMNS],
      ['maybeSingle'],
    ]);
    expect(queries[7].ops).toEqual([
      ['update', { status: 'failed', error: 'restart', finished_at: 'now' }],
      ['in', 'status', ['queued', 'running']],
      ['lt', 'heartbeat_at', 'cutoff'],
      ['select', 'id'],
    ]);
    expect(queries[9].ops).toEqual([
      ['select', DOCUMENT_EXPORT_COLUMNS],
      ['eq', 'status', 'ready'],
      ['lte', 'expires_at', 'now'],
    ]);
  });

  it('claims and finishes only exports the given owner holds, and heartbeats its unfinished ones', async () => {
    const row = { id: ID };
    const { client, queries } = recordingSupabase({
      document_exports: [ok(row), ok([row]), ok(null)],
    });
    const repo = new SupabaseDocumentExportsRepository(client);
    await expect(
      repo.updateIfStatus(ID, ['running'], { status: 'ready' }, 'm-1'),
    ).resolves.toEqual(row);
    await expect(repo.heartbeat('m-1', 'now')).resolves.toBe(1);
    await expect(repo.heartbeat('m-1', 'now')).resolves.toBe(0);
    expect(queries[0].ops).toEqual([
      ['update', { status: 'ready' }],
      ['eq', 'id', ID],
      ['in', 'status', ['running']],
      ['eq', 'owner_id', 'm-1'],
      ['select', DOCUMENT_EXPORT_COLUMNS],
      ['maybeSingle'],
    ]);
    expect(queries[1].ops).toEqual([
      ['update', { heartbeat_at: 'now' }],
      ['eq', 'owner_id', 'm-1'],
      ['in', 'status', ['queued', 'running']],
      ['select', 'id'],
    ]);
  });

  it('calls document_template_assignments with every filter', async () => {
    const row = { id: ID, total_count: 1 };
    const { client, queries } = recordingSupabase({
      'rpc:document_template_assignments': [ok([row]), ok(null)],
    });
    const repo = new SupabaseDocumentExportsRepository(client);
    const query = {
      templateId: ID,
      season: '2026/27',
      status: 'completed' as const,
      patterns: ['%ann%'],
      ids: [ID],
      signedOnly: true,
      limit: 50,
      offset: 100,
    };
    await expect(repo.listTemplateAssignments(query)).resolves.toEqual([row]);
    await expect(repo.listTemplateAssignments(query)).resolves.toEqual([]);
    expect(queries[0]).toEqual({
      table: 'rpc:document_template_assignments',
      ops: [
        [
          'rpc',
          {
            p_template_id: ID,
            p_season: '2026/27',
            p_status: 'completed',
            p_patterns: ['%ann%'],
            p_ids: [ID],
            p_signed_only: true,
            p_limit: 50,
            p_offset: 100,
          },
        ],
      ],
    });
  });

  it.each([
    [
      'insert',
      (r: SupabaseDocumentExportsRepository) =>
        r.insert({
          template_id: ID,
          season: null,
          assignment_ids: null,
          requested_by: ID,
          owner_id: 'm-1',
          heartbeat_at: 'now',
        }),
    ],
    ['findById', (r: SupabaseDocumentExportsRepository) => r.findById(ID)],
    [
      'listForTemplate',
      (r: SupabaseDocumentExportsRepository) => r.listForTemplate(ID, 10),
    ],
    [
      'updateIfStatus',
      (r: SupabaseDocumentExportsRepository) =>
        r.updateIfStatus(ID, ['ready'], { status: 'expired' }),
    ],
    [
      'failStale',
      (r: SupabaseDocumentExportsRepository) => r.failStale('c', 'x', 'now'),
    ],
    [
      'heartbeat',
      (r: SupabaseDocumentExportsRepository) => r.heartbeat('m-1', 'now'),
    ],
    [
      'listExpired',
      (r: SupabaseDocumentExportsRepository) => r.listExpired('now'),
    ],
  ])('%s surfaces database errors', async (_name, call) => {
    const { client } = recordingSupabase({ document_exports: [fail] });
    await expect(
      call(new SupabaseDocumentExportsRepository(client)),
    ).rejects.toThrow('boom');
  });

  it('listTemplateAssignments surfaces database errors', async () => {
    const { client } = recordingSupabase({
      'rpc:document_template_assignments': [fail],
    });
    await expect(
      new SupabaseDocumentExportsRepository(client).listTemplateAssignments({
        templateId: ID,
        season: null,
        status: 'all',
        patterns: [],
        ids: null,
        signedOnly: false,
        limit: 1,
        offset: 0,
      }),
    ).rejects.toThrow('boom');
  });
});
