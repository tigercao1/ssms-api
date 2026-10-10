import { SupabaseInstructorSyncRepository } from './instructor-sync.repository';

interface Result {
  data: unknown;
  error: { message: string } | null;
}

interface RecordedQuery {
  table: string;
  ops: [string, ...unknown[]][];
}

function fakeSupabase(
  tables: Record<string, Result> = {},
  rpcs: Record<string, Result> = {},
) {
  const queries: RecordedQuery[] = [];
  const rpcCalls: { name: string; args: unknown }[] = [];
  const client = {
    from(table: string) {
      const query: RecordedQuery = { table, ops: [] };
      queries.push(query);
      const result = tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        then: (resolve: (r: Result) => unknown, reject: (e: unknown) => void) =>
          Promise.resolve(result).then(resolve, reject),
      };
      for (const op of [
        'select',
        'eq',
        'neq',
        'limit',
        'upsert',
        'update',
        'delete',
        'maybeSingle',
      ]) {
        builder[op] = (...args: unknown[]) => {
          query.ops.push([op, ...args]);
          return builder;
        };
      }
      return builder;
    },
    rpc(name: string, args?: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpcs[name] ?? { data: null, error: null });
    },
  };
  return {
    repo: new SupabaseInstructorSyncRepository(client as never),
    queries,
    rpcCalls,
    opsFor: (table: string) =>
      queries.filter((q) => q.table === table).map((q) => q.ops),
  };
}

const failure = { data: null, error: { message: 'boom' } };

describe('SupabaseInstructorSyncRepository', () => {
  describe('loadSnapshot', () => {
    it('returns null when the instructor no longer exists', async () => {
      const { repo, queries } = fakeSupabase();
      await expect(repo.loadSnapshot('i-1')).resolves.toBeNull();
      expect(queries).toHaveLength(1);
    });

    it('reads the instructor in any state plus active, ordered reference names', async () => {
      const instructor = { id: 'i-1', approval_status: 'pending' };
      const { repo, opsFor } = fakeSupabase({
        instructors: { data: instructor, error: null },
        instructors_teaching_locations: {
          data: [
            {
              teaching_locations: {
                name: 'Whistler',
                sort_order: 2,
                is_active: true,
              },
            },
            {
              teaching_locations: {
                name: 'Banff',
                sort_order: 1,
                is_active: true,
              },
            },
            {
              teaching_locations: {
                name: 'Closed',
                sort_order: 0,
                is_active: false,
              },
            },
            { teaching_locations: null },
          ],
          error: null,
        },
        instructors_languages: {
          data: [
            { languages: { name: 'Mandarin', sort_order: 1, is_active: true } },
            { languages: { name: 'English', sort_order: 1, is_active: true } },
          ],
          error: null,
        },
        instructor_certifications: {
          data: [
            { org: 'csia', track: 'regular', level: 2, is_partial: false },
          ],
          error: null,
        },
      });

      const snapshot = await repo.loadSnapshot('i-1');

      expect(snapshot).toEqual({
        instructor,
        locations: ['Banff', 'Whistler'],
        languages: ['English', 'Mandarin'],
        courseLevels: [],
        examPreparations: [],
        certifications: [
          { org: 'csia', track: 'regular', level: 2, is_partial: false },
        ],
        trainers: [],
      });
      const [instructorOps] = opsFor('instructors');
      expect(instructorOps).toContainEqual(['eq', 'id', 'i-1']);
      expect(instructorOps).not.toContainEqual([
        'eq',
        'approval_status',
        'approved',
      ]);
      expect(opsFor('instructors_exam_preparations')[0]).toContainEqual([
        'select',
        'exam_preparations:exam_preparation_id ( name, sort_order, is_active )',
      ]);
    });

    it('throws when a read fails', async () => {
      await expect(
        fakeSupabase({ instructors: failure }).repo.loadSnapshot('i-1'),
      ).rejects.toThrow('Failed to load instructor: boom');
      await expect(
        fakeSupabase({
          instructors: { data: { id: 'i-1' }, error: null },
          instructor_trainer_status: failure,
        }).repo.loadSnapshot('i-1'),
      ).rejects.toThrow('instructor_trainer_status');
      await expect(
        fakeSupabase({
          instructors: { data: { id: 'i-1' }, error: null },
          instructors_languages: failure,
        }).repo.loadSnapshot('i-1'),
      ).rejects.toThrow('load languages');
    });
  });

  describe('state', () => {
    it('reads the state row or null', async () => {
      const row = { instructor_id: 'i-1', shopify_handle: 'eddie' };
      await expect(
        fakeSupabase({
          instructor_shopify_state: { data: row, error: null },
        }).repo.getState('i-1'),
      ).resolves.toEqual(row);
      await expect(fakeSupabase().repo.getState('i-1')).resolves.toBeNull();
      await expect(
        fakeSupabase({ instructor_shopify_state: failure }).repo.getState(
          'i-1',
        ),
      ).rejects.toThrow('boom');
    });

    it('upserts only the given columns', async () => {
      const { repo, opsFor } = fakeSupabase();
      await repo.saveState('i-1', { shopify_handle: 'eddie' });
      expect(opsFor('instructor_shopify_state')[0]).toEqual([
        [
          'upsert',
          { instructor_id: 'i-1', shopify_handle: 'eddie' },
          { onConflict: 'instructor_id' },
        ],
      ]);
      await expect(
        fakeSupabase({ instructor_shopify_state: failure }).repo.saveState(
          'i-1',
          {},
        ),
      ).rejects.toThrow('boom');
    });

    it('reports whether another instructor holds a handle', async () => {
      const taken = fakeSupabase({
        instructor_shopify_state: {
          data: [{ instructor_id: 'i-2' }],
          error: null,
        },
      });
      await expect(
        taken.repo.isHandleStoredByOther('eddie', 'i-1'),
      ).resolves.toBe(true);
      expect(taken.opsFor('instructor_shopify_state')[0]).toEqual(
        expect.arrayContaining([
          ['eq', 'shopify_handle', 'eddie'],
          ['neq', 'instructor_id', 'i-1'],
        ]),
      );
      await expect(
        fakeSupabase().repo.isHandleStoredByOther('eddie', 'i-1'),
      ).resolves.toBe(false);
      await expect(
        fakeSupabase({
          instructor_shopify_state: failure,
        }).repo.isHandleStoredByOther('eddie', 'i-1'),
      ).rejects.toThrow('boom');
    });
  });

  describe('queue', () => {
    const row = {
      instructor_id: 'i-1',
      enqueued_at: '2026-10-10T03:00:00.123456+00:00',
      attempts: 2,
      last_error: null,
    };

    it('claims through the skip-locked RPC', async () => {
      const { repo, rpcCalls } = fakeSupabase(
        {},
        { claim_instructor_sync_batch: { data: [row], error: null } },
      );
      await expect(repo.claimQueueBatch(10, 10)).resolves.toEqual([row]);
      expect(rpcCalls).toEqual([
        {
          name: 'claim_instructor_sync_batch',
          args: { p_limit: 10, p_max_attempts: 10 },
        },
      ]);
      await expect(
        fakeSupabase().repo.claimQueueBatch(10, 10),
      ).resolves.toEqual([]);
      await expect(
        fakeSupabase(
          {},
          { claim_instructor_sync_batch: failure },
        ).repo.claimQueueBatch(10, 10),
      ).rejects.toThrow('boom');
    });

    it('deletes a finished row only where enqueued_at still matches', async () => {
      const { repo, opsFor } = fakeSupabase();
      await repo.completeQueueRow(row);
      expect(opsFor('instructor_sync_queue')[0]).toEqual([
        ['delete'],
        ['eq', 'instructor_id', 'i-1'],
        ['eq', 'enqueued_at', '2026-10-10T03:00:00.123456+00:00'],
      ]);
      await expect(
        fakeSupabase({ instructor_sync_queue: failure }).repo.completeQueueRow(
          row,
        ),
      ).rejects.toThrow('boom');
    });

    it('records a failure by bumping attempts and keeping the error', async () => {
      const { repo, opsFor } = fakeSupabase();
      await repo.recordQueueFailure(row, 'Shopify down');
      expect(opsFor('instructor_sync_queue')[0]).toEqual([
        ['update', { attempts: 3, last_error: 'Shopify down' }],
        ['eq', 'instructor_id', 'i-1'],
      ]);
      await expect(
        fakeSupabase({
          instructor_sync_queue: failure,
        }).repo.recordQueueFailure(row, 'x'),
      ).rejects.toThrow('boom');
    });

    it('enqueues everything and returns the counts', async () => {
      const { repo } = fakeSupabase(
        {},
        {
          enqueue_all_instructor_sync: {
            data: [{ instructor_count: 2, orphaned_count: 1 }],
            error: null,
          },
        },
      );
      await expect(repo.enqueueAll()).resolves.toEqual({
        instructors: 2,
        orphaned: 1,
      });
      await expect(fakeSupabase().repo.enqueueAll()).resolves.toEqual({
        instructors: 0,
        orphaned: 0,
      });
      await expect(
        fakeSupabase(
          {},
          { enqueue_all_instructor_sync: failure },
        ).repo.enqueueAll(),
      ).rejects.toThrow('boom');
    });
  });
});
