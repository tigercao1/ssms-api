import { Test } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { ReferenceDataService } from './reference-data.service';

/**
 * Builds a Supabase client double whose query builder is thenable and records
 * the chained calls, so we can assert the active-only filter + sort order.
 */
function makeSupabaseStub(result: {
  data?: unknown;
  error?: { message: string } | null;
}) {
  const calls: { from?: string; eq?: unknown[]; order: unknown[][] } = {
    order: [],
  };
  const builder: Record<string, unknown> = {};
  builder.select = jest.fn(() => builder);
  builder.eq = jest.fn((...args: unknown[]) => {
    calls.eq = args;
    return builder;
  });
  builder.order = jest.fn((...args: unknown[]) => {
    calls.order.push(args);
    return builder;
  });
  // Make the builder awaitable, resolving to the Supabase-style result.
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({
      data: result.data ?? null,
      error: result.error ?? null,
    }).then(resolve);

  const client = {
    from: jest.fn((table: string) => {
      calls.from = table;
      return builder;
    }),
  };
  return { client, calls };
}

async function buildService(stub: ReturnType<typeof makeSupabaseStub>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReferenceDataService,
      { provide: SUPABASE_CLIENT, useValue: stub.client },
    ],
  }).compile();
  return moduleRef.get(ReferenceDataService);
}

describe('ReferenceDataService', () => {
  it('maps rows and projects sort_order -> sortOrder', async () => {
    const stub = makeSupabaseStub({
      data: [
        { id: 'a', key: 'language.en', name: 'English', sort_order: 1 },
        { id: 'b', key: 'language.fr', name: 'French', sort_order: 2 },
      ],
    });
    const service = await buildService(stub);

    const result = await service.getLanguages();

    expect(stub.calls.from).toBe('languages');
    expect(result).toEqual([
      { id: 'a', key: 'language.en', name: 'English', sortOrder: 1 },
      { id: 'b', key: 'language.fr', name: 'French', sortOrder: 2 },
    ]);
  });

  it('filters to active rows and sorts by sort_order then key', async () => {
    const stub = makeSupabaseStub({ data: [] });
    const service = await buildService(stub);

    await service.getTeachingLocations();

    expect(stub.calls.from).toBe('teaching_locations');
    expect(stub.calls.eq).toEqual(['is_active', true]);
    expect(stub.calls.order).toEqual([
      ['sort_order', { ascending: true }],
      ['key', { ascending: true }],
    ]);
  });

  it('returns an empty array when the table has no rows', async () => {
    const stub = makeSupabaseStub({ data: null });
    const service = await buildService(stub);

    await expect(service.getExamPreparations()).resolves.toEqual([]);
    expect(stub.calls.from).toBe('exam_preparations');
  });

  it('queries the course_levels_offered table', async () => {
    const stub = makeSupabaseStub({ data: [] });
    const service = await buildService(stub);

    await service.getCourseLevelsOffered();

    expect(stub.calls.from).toBe('course_levels_offered');
  });

  it('throws InternalServerErrorException on a Supabase error', async () => {
    const stub = makeSupabaseStub({ error: { message: 'boom' } });
    const service = await buildService(stub);

    await expect(service.getLanguages()).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
