import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import {
  LESSON_PRODUCT_COLUMNS,
  SupabaseLessonProductsRepository,
} from './lesson-products.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const fail = { data: null, error: { message: 'boom' } };

describe('SupabaseLessonProductsRepository', () => {
  it('joins instructor names with their Shopify handles', async () => {
    const { client } = recordingSupabase({
      instructors: {
        data: [
          { id: 'a', display_name_en: 'Eddie' },
          { id: 'b', display_name_en: 'Eric Wang' },
        ],
        error: null,
      },
      instructor_shopify_state: {
        data: [{ instructor_id: 'a', shopify_handle: 'eddie' }],
        error: null,
      },
    });
    const repo = new SupabaseLessonProductsRepository(client);
    await expect(repo.instructorHandleSources()).resolves.toEqual([
      { id: 'a', displayNameEn: 'Eddie', shopifyHandle: 'eddie' },
      { id: 'b', displayNameEn: 'Eric Wang', shopifyHandle: null },
    ]);
  });

  it('treats empty instructor results as no instructors', async () => {
    const { client } = recordingSupabase();
    const repo = new SupabaseLessonProductsRepository(client);
    await expect(repo.instructorHandleSources()).resolves.toEqual([]);
  });

  it('fails loudly when the handle lookup fails', async () => {
    const { client } = recordingSupabase({ instructor_shopify_state: fail });
    const repo = new SupabaseLessonProductsRepository(client);
    await expect(repo.instructorHandleSources()).rejects.toThrow(
      'Failed to load instructor Shopify handles: boom',
    );
  });

  it('checks whether an instructor exists', async () => {
    const { client } = recordingSupabase({
      instructors: [
        { data: { id: ID }, error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseLessonProductsRepository(client);
    await expect(repo.instructorExists(ID)).resolves.toBe(true);
    await expect(repo.instructorExists(ID)).resolves.toBe(false);
  });

  it('sends rows to sync_lesson_products and reads its counts', async () => {
    const { client, queries } = recordingSupabase({
      'rpc:sync_lesson_products': [
        { data: [{ inserted: 2, updated: 1 }], error: null },
        { data: { inserted: 0, updated: 3 }, error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseLessonProductsRepository(client);
    await expect(repo.sync([])).resolves.toEqual({ inserted: 2, updated: 1 });
    await expect(repo.sync([])).resolves.toEqual({ inserted: 0, updated: 3 });
    await expect(repo.sync([])).resolves.toEqual({ inserted: 0, updated: 0 });
    expect(queries[0].ops[0]).toEqual(['args', { p_rows: [] }]);
  });

  it('surfaces sync errors', async () => {
    const { client } = recordingSupabase({ 'rpc:sync_lesson_products': fail });
    const repo = new SupabaseLessonProductsRepository(client);
    await expect(repo.sync([])).rejects.toThrow(
      'Failed to sync lesson products: boom',
    );
  });

  it('filters the list by status only when asked', async () => {
    const { client, queries } = recordingSupabase({
      lesson_products: { data: [{ id: ID }], error: null },
    });
    const repo = new SupabaseLessonProductsRepository(client);
    await expect(repo.list('confirmed')).resolves.toEqual([{ id: ID }]);
    await repo.list();
    expect(queries[0].ops).toContainEqual(['eq', 'status', 'confirmed']);
    expect(queries[1].ops.some(([op]) => op === 'eq')).toBe(false);
    expect(queries[0].ops[0]).toEqual(['select', LESSON_PRODUCT_COLUMNS]);
  });

  it('returns an empty list and null rows when nothing matches', async () => {
    const { client } = recordingSupabase();
    const repo = new SupabaseLessonProductsRepository(client);
    await expect(repo.list()).resolves.toEqual([]);
    await expect(repo.findById(ID)).resolves.toBeNull();
    await expect(repo.update(ID, 'ts', {})).resolves.toBeNull();
  });

  it('updates only when updated_at still matches', async () => {
    const { client, queries } = recordingSupabase({
      lesson_products: { data: [{ id: ID, status: 'confirmed' }], error: null },
    });
    const repo = new SupabaseLessonProductsRepository(client);
    await expect(
      repo.update(ID, '2026-10-10T00:00:00Z', { status: 'confirmed' }),
    ).resolves.toEqual({ id: ID, status: 'confirmed' });
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['update', { status: 'confirmed' }],
        ['eq', 'id', ID],
        ['eq', 'updated_at', '2026-10-10T00:00:00Z'],
      ]),
    );
  });

  it.each([
    ['list', (r: SupabaseLessonProductsRepository) => r.list()],
    ['findById', (r: SupabaseLessonProductsRepository) => r.findById(ID)],
    ['update', (r: SupabaseLessonProductsRepository) => r.update(ID, 't', {})],
    [
      'instructorExists',
      (r: SupabaseLessonProductsRepository) => r.instructorExists(ID),
    ],
  ])('%s surfaces database errors', async (_name, call) => {
    const { client } = recordingSupabase({
      lesson_products: fail,
      instructors: fail,
    });
    await expect(
      call(new SupabaseLessonProductsRepository(client)),
    ).rejects.toThrow('boom');
  });
});
