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

  describe('files', () => {
    it('surfaces fileCreate errors other than a duplicate name', async () => {
      const shopify = new FakeShopify();
      shopify.on('SsmsPhotoCreate', () => ({
        fileCreate: {
          files: [],
          userErrors: [
            {
              field: ['files'],
              message: 'bad url',
              code: 'INVALID_IMAGE_SOURCE_URL',
            },
          ],
        },
      }));
      const gateway = new ShopifyInstructorGateway(shopify.client);
      await expect(gateway.createImage('https://x', 'a.jpg')).rejects.toThrow(
        'bad url',
      );
      expect(shopify.operations()).not.toContain('SsmsPhotoByName');
    });

    it('throws when fileCreate returns no file', async () => {
      const shopify = new FakeShopify();
      shopify.on('SsmsPhotoCreate', () => ({
        fileCreate: { files: null, userErrors: [] },
      }));
      const gateway = new ShopifyInstructorGateway(shopify.client);
      await expect(gateway.createImage('https://x', 'a.jpg')).rejects.toThrow(
        'returned no file',
      );
    });

    it('matches a file by its exact name, or takes a single unprocessed hit', async () => {
      const shopify = new FakeShopify();
      const gateway = new ShopifyInstructorGateway(shopify.client);
      shopify.on('SsmsPhotoByName', () => ({
        files: {
          nodes: [
            {
              id: 'f-1',
              fileStatus: 'READY',
              image: { url: 'https://cdn/files/a-1.jpg?v=1' },
            },
            {
              id: 'f-2',
              fileStatus: 'READY',
              image: { url: 'https://cdn/files/a.jpg?v=1' },
            },
          ],
        },
      }));
      await expect(gateway.findImageByName('a.jpg')).resolves.toEqual({
        id: 'f-2',
        fileStatus: 'READY',
      });
      expect(shopify.calls[0].variables).toEqual({ query: 'filename:"a.jpg"' });

      shopify.on('SsmsPhotoByName', () => ({
        files: { nodes: [{ id: 'f-3', fileStatus: 'UPLOADED', image: null }] },
      }));
      await expect(gateway.findImageByName('a.jpg')).resolves.toEqual({
        id: 'f-3',
        fileStatus: 'UPLOADED',
      });

      shopify.on('SsmsPhotoByName', () => ({
        files: {
          nodes: [
            { id: 'f-4', fileStatus: 'UPLOADED' },
            { id: 'f-5', fileStatus: 'UPLOADED' },
          ],
        },
      }));
      await expect(gateway.findImageByName('a.jpg')).resolves.toBeNull();
    });

    it('reports file status without errors as an empty list', async () => {
      const shopify = new FakeShopify();
      shopify.on('SsmsPhotoStatus', () => ({
        node: { id: 'f-1', fileStatus: 'READY', fileErrors: null },
      }));
      const gateway = new ShopifyInstructorGateway(shopify.client);
      await expect(gateway.fileState('f-1')).resolves.toEqual({
        id: 'f-1',
        fileStatus: 'READY',
        errors: [],
      });
    });
  });
});
