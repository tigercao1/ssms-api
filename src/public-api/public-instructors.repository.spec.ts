import { Test } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import {
  PublicInstructorsRepository,
  SupabasePublicInstructorsRepository,
} from './public-instructors.repository';
import { ListInstructorsParams } from './public-api.types';

const baseParams: ListInstructorsParams = {
  locale: 'en',
  page: 1,
  trainersOnly: false,
  sort: 'name',
};

async function build(client: unknown): Promise<PublicInstructorsRepository> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      {
        provide: PublicInstructorsRepository,
        useClass: SupabasePublicInstructorsRepository,
      },
      { provide: SUPABASE_CLIENT, useValue: client },
    ],
  }).compile();
  return moduleRef.get(PublicInstructorsRepository);
}

describe('SupabasePublicInstructorsRepository', () => {
  describe('listVisible', () => {
    it('calls the RPC with normalized params and maps id + total_count', async () => {
      const rpc = jest.fn().mockResolvedValue({
        data: [
          { id: 'a', total_count: 2 },
          { id: 'b', total_count: 2 },
        ],
        error: null,
      });
      const repo = await build({ rpc });

      const result = await repo.listVisible({
        ...baseParams,
        locale: 'zh-CN',
        locations: ['blue-mountain'],
        minCsiaLevel: 3,
        trainersOnly: true,
        sort: 'seniority',
        order: 'asc',
      });

      expect(rpc).toHaveBeenCalledWith('public_list_instructors', {
        p_locale: 'zh-CN',
        p_page: 1,
        p_page_size: 50,
        p_locations: ['blue-mountain'],
        p_languages: null,
        p_disciplines: null,
        p_min_csia: 3,
        p_min_casi: null,
        p_trainers_only: true,
        p_sort: 'seniority',
        p_order: 'asc',
      });
      expect(result).toEqual({ ids: ['a', 'b'], totalCount: 2 });
    });

    it('returns zero totalCount when the RPC yields no rows', async () => {
      const repo = await build({
        rpc: jest.fn().mockResolvedValue({ data: [], error: null }),
      });
      expect(await repo.listVisible(baseParams)).toEqual({
        ids: [],
        totalCount: 0,
      });
    });

    it('throws on RPC error', async () => {
      const repo = await build({
        rpc: jest
          .fn()
          .mockResolvedValue({ data: null, error: { message: 'x' } }),
      });
      await expect(repo.listVisible(baseParams)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('findVisibleById', () => {
    it('applies the approved + active visibility predicate', async () => {
      const calls: { eq: unknown[][] } = { eq: [] };
      const builder: Record<string, unknown> = {};
      builder.select = jest.fn(() => builder);
      builder.eq = jest.fn((...args: unknown[]) => {
        calls.eq.push(args);
        return builder;
      });
      builder.maybeSingle = jest
        .fn()
        .mockResolvedValue({ data: { id: 'a' }, error: null });
      const repo = await build({ from: jest.fn(() => builder) });

      const result = await repo.findVisibleById('a');

      expect(result).toEqual({ id: 'a' });
      expect(calls.eq).toEqual([
        ['id', 'a'],
        ['approval_status', 'approved'],
        ['is_active', true],
      ]);
    });
  });

  describe('findVisibleByIds', () => {
    it('short-circuits to [] for an empty id list (no DB call)', async () => {
      const from = jest.fn();
      const repo = await build({ from });
      expect(await repo.findVisibleByIds([])).toEqual([]);
      expect(from).not.toHaveBeenCalled();
    });
  });
});
