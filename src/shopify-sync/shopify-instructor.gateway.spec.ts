import { FakeShopify } from '../../test/helpers/shopify-sync-fakes';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';

describe('ShopifyInstructorGateway', () => {
  it('maps an entry without an ssms_id to a null owner', async () => {
    const shopify = new FakeShopify();
    const entry = shopify.addEntry('eddie');
    const gateway = new ShopifyInstructorGateway(shopify.client);
    await expect(gateway.findEntryByHandle('eddie')).resolves.toEqual({
      id: entry.id,
      ssmsId: null,
    });
    await expect(gateway.findEntryByHandle('nobody')).resolves.toBeNull();
  });

  it('only ever addresses the ssms_instructor type', async () => {
    const shopify = new FakeShopify();
    const gateway = new ShopifyInstructorGateway(shopify.client);
    await gateway.findEntryByHandle('eddie');
    await gateway.upsertEntry('eddie', [{ key: 'name', value: 'E' }], 'ACTIVE');
    await gateway.setEntryStatus('eddie', 'DRAFT');
    expect(
      shopify.calls.map((c) => (c.variables.handle as { type: string }).type),
    ).toEqual(['ssms_instructor', 'ssms_instructor', 'ssms_instructor']);
  });

  it('throws when an upsert returns no metaobject', async () => {
    const shopify = new FakeShopify();
    shopify.on('SsmsInstructorUpsert', () => ({
      metaobjectUpsert: { metaobject: null, userErrors: [] },
    }));
    const gateway = new ShopifyInstructorGateway(shopify.client);
    await expect(gateway.setEntryStatus('eddie', 'DRAFT')).rejects.toThrow(
      'returned no metaobject',
    );
  });
});
