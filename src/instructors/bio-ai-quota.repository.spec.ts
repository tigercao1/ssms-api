import { InternalServerErrorException } from '@nestjs/common';
import { SupabaseBioAiQuotaRepository } from './bio-ai-quota.repository';

type Result = { data: unknown; error: { message: string } | null };

class FakeSupabase {
  result: Result = { data: null, error: null };
  rpcCalls: Array<{ name: string; params: unknown }> = [];
  deletes: Array<{ table: string; column: string; value: string }> = [];

  rpc(name: string, params: unknown) {
    this.rpcCalls.push({ name, params });
    return { single: () => Promise.resolve(this.result) };
  }

  from(table: string) {
    return {
      delete: () => ({
        eq: (column: string, value: string) => {
          this.deletes.push({ table, column, value });
          return Promise.resolve({ error: this.result.error });
        },
      }),
    };
  }
}

function makeRepo() {
  const fake = new FakeSupabase();
  return { fake, repo: new SupabaseBioAiQuotaRepository(fake as never) };
}

describe('SupabaseBioAiQuotaRepository', () => {
  it('reads the window through bio_ai_usage', async () => {
    const { fake, repo } = makeRepo();
    fake.result = {
      data: { used: 2, oldest_at: '2026-10-13T10:00:00+00:00' },
      error: null,
    };
    await expect(repo.usage('inst-1')).resolves.toEqual({
      used: 2,
      oldestAt: '2026-10-13T10:00:00+00:00',
    });
    expect(fake.rpcCalls).toEqual([
      { name: 'bio_ai_usage', params: { p_instructor_id: 'inst-1' } },
    ]);
  });

  it('reserves through reserve_bio_ai_request', async () => {
    const { fake, repo } = makeRepo();
    fake.result = {
      data: {
        request_id: 'req-1',
        used: 1,
        oldest_at: '2026-10-14T02:00:00+00:00',
      },
      error: null,
    };
    await expect(repo.reserve('inst-1', 'translate', 5)).resolves.toEqual({
      requestId: 'req-1',
      used: 1,
      oldestAt: '2026-10-14T02:00:00+00:00',
    });
    expect(fake.rpcCalls).toEqual([
      {
        name: 'reserve_bio_ai_request',
        params: { p_instructor_id: 'inst-1', p_mode: 'translate', p_limit: 5 },
      },
    ]);
  });

  it('reports a refused reservation with a null request id', async () => {
    const { fake, repo } = makeRepo();
    fake.result = {
      data: { request_id: null, used: 5, oldest_at: '2026-10-14T02:00:00Z' },
      error: null,
    };
    await expect(repo.reserve('inst-1', 'refine', 5)).resolves.toMatchObject({
      requestId: null,
      used: 5,
    });
  });

  it('releases by deleting the request row', async () => {
    const { fake, repo } = makeRepo();
    await repo.release('req-1');
    expect(fake.deletes).toEqual([
      { table: 'bio_ai_requests', column: 'id', value: 'req-1' },
    ]);
  });

  it('surfaces database errors as 500s', async () => {
    const { fake, repo } = makeRepo();
    fake.result = { data: null, error: { message: 'boom' } };
    await expect(repo.usage('inst-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    await expect(repo.reserve('inst-1', 'refine', 5)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    await expect(repo.release('req-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
