import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { DatabaseError } from '../database/db-result';
import {
  MAX_WEBHOOK_ERROR_LENGTH,
  SupabaseShopifyWebhookEventsRepository,
} from './shopify-webhook-events.repository';

const event = {
  webhook_id: 'w-1',
  topic: 'customers/update',
  shopify_customer_id: 501,
  triggered_at: '2026-10-13T12:00:00.000Z',
};
const fail = { data: null, error: { message: 'boom' } };

describe('SupabaseShopifyWebhookEventsRepository', () => {
  it('claims a new delivery once and tells a processed duplicate from an unfinished one', async () => {
    const { client, queries } = recordingSupabase({
      shopify_webhook_events: [
        { data: [{ webhook_id: 'w-1' }], error: null },
        { data: [], error: null },
        { data: { processed_at: '2026-10-13T12:00:01Z' }, error: null },
        { data: [], error: null },
        { data: { processed_at: null }, error: null },
      ],
    });
    const repo = new SupabaseShopifyWebhookEventsRepository(client);
    await expect(repo.claim(event)).resolves.toBe('new');
    await expect(repo.claim(event)).resolves.toBe('processed');
    await expect(repo.claim(event)).resolves.toBe('unfinished');
    expect(queries[0].ops).toEqual([
      ['upsert', event, { onConflict: 'webhook_id', ignoreDuplicates: true }],
      ['select', 'webhook_id'],
    ]);
    expect(queries[2].ops).toEqual([
      ['select', 'processed_at'],
      ['eq', 'webhook_id', 'w-1'],
      ['maybeSingle'],
    ]);
  });

  it('finishes, fails and prunes deliveries, truncating long errors', async () => {
    const { client, queries } = recordingSupabase();
    const repo = new SupabaseShopifyWebhookEventsRepository(client);
    await repo.finish('w-1', null);
    await repo.fail('w-2', 'x'.repeat(MAX_WEBHOOK_ERROR_LENGTH + 5));
    await repo.prune('2026-09-13T00:00:00.000Z');
    expect(queries[0].ops).toEqual([
      ['update', { processed_at: expect.any(String) as unknown, error: null }],
      ['eq', 'webhook_id', 'w-1'],
    ]);
    expect(queries[1].ops).toEqual([
      ['update', { error: 'x'.repeat(MAX_WEBHOOK_ERROR_LENGTH) }],
      ['eq', 'webhook_id', 'w-2'],
    ]);
    expect(queries[2].ops).toEqual([
      ['delete'],
      ['lt', 'received_at', '2026-09-13T00:00:00.000Z'],
    ]);
  });

  it('reports the newest delivery and the count since a time', async () => {
    const { client, queries } = recordingSupabase({
      shopify_webhook_events: [
        { data: { received_at: '2026-10-13T12:00:00Z' }, error: null },
        { data: null, error: null, count: 4 },
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseShopifyWebhookEventsRepository(client);
    await expect(repo.stats('2026-10-12T12:00:00Z')).resolves.toEqual({
      lastReceivedAt: '2026-10-13T12:00:00Z',
      receivedSince: 4,
    });
    await expect(repo.stats('2026-10-12T12:00:00Z')).resolves.toEqual({
      lastReceivedAt: null,
      receivedSince: 0,
    });
    expect(queries[1].ops).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
      ['gte', 'received_at', '2026-10-12T12:00:00Z'],
    ]);
  });

  it.each([
    ['claim', (r: SupabaseShopifyWebhookEventsRepository) => r.claim(event)],
    [
      'finish',
      (r: SupabaseShopifyWebhookEventsRepository) => r.finish('w', 'e'),
    ],
    ['fail', (r: SupabaseShopifyWebhookEventsRepository) => r.fail('w', 'e')],
    ['prune', (r: SupabaseShopifyWebhookEventsRepository) => r.prune('x')],
    ['stats', (r: SupabaseShopifyWebhookEventsRepository) => r.stats('x')],
  ])('%s surfaces database errors', async (_name, call) => {
    const { client } = recordingSupabase({ shopify_webhook_events: fail });
    await expect(
      call(new SupabaseShopifyWebhookEventsRepository(client)),
    ).rejects.toThrow(DatabaseError);
  });

  it('surfaces a failing duplicate lookup and a failing count', async () => {
    const { client } = recordingSupabase({
      shopify_webhook_events: [{ data: [], error: null }, fail],
    });
    const repo = new SupabaseShopifyWebhookEventsRepository(client);
    await expect(repo.claim(event)).rejects.toThrow('load Shopify webhook');
    const counting = recordingSupabase({
      shopify_webhook_events: [{ data: null, error: null }, fail],
    });
    await expect(
      new SupabaseShopifyWebhookEventsRepository(counting.client).stats('x'),
    ).rejects.toThrow('count Shopify webhooks');
  });
});
