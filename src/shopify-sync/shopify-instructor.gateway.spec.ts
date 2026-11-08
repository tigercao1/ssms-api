import { FakeShopify } from '../../test/helpers/shopify-sync-fakes';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';

describe('ShopifyInstructorGateway', () => {
  it('maps an entry without an ssms_id to a null owner', async () => {
    const shopify = new FakeShopify();
    const entry = shopify.addEntry('eddie');
    const gateway = new ShopifyInstructorGateway(shopify.client);
    await expect(gateway.findEntryByHandle('eddie')).resolves.toEqual({
      id: entry.id,
      handle: 'eddie',
      ssmsId: null,
    });
    await expect(gateway.findEntryByHandle('nobody')).resolves.toBeNull();
  });

  it('only ever addresses the ssms_instructor type', async () => {
    const shopify = new FakeShopify();
    const gateway = new ShopifyInstructorGateway(shopify.client);
    await gateway.findEntryByHandle('eddie');
    await gateway.upsertEntry('eddie', [{ key: 'name', value: 'E' }], 'ACTIVE');
    expect(
      shopify.calls.map((c) => (c.variables.handle as { type: string }).type),
    ).toEqual(['ssms_instructor', 'ssms_instructor']);
  });

  it('lists every legacy our_team entry across pages by handle and name', async () => {
    const shopify = new FakeShopify();
    shopify.on('SsmsLegacyRoster', (v) =>
      v.after == null
        ? {
            metaobjects: {
              pageInfo: { hasNextPage: true, endCursor: 'c1' },
              nodes: [
                {
                  handle: 'aaron',
                  displayName: 'x',
                  name: { value: ' Aaron ' },
                },
              ],
            },
          }
        : {
            metaobjects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { handle: 'bea', displayName: 'Bea', name: null },
                { handle: 'cy', displayName: null, name: null },
              ],
            },
          },
    );
    const gateway = new ShopifyInstructorGateway(shopify.client);

    await expect(gateway.listLegacyEntries()).resolves.toEqual([
      { handle: 'aaron', name: 'Aaron' },
      { handle: 'bea', name: 'Bea' },
      { handle: 'cy', name: '' },
    ]);
    expect(shopify.calls.map((c) => c.variables)).toEqual([
      { type: 'our_team', first: 250, after: null },
      { type: 'our_team', first: 250, after: 'c1' },
    ]);
  });

  it('reads an entry by id and ignores ids of other metaobject types', async () => {
    const shopify = new FakeShopify();
    const entry = shopify.addEntry('lele', { ssms_id: 'abc' });
    const legacy = shopify.addLegacyEntry('aaron', 'Aaron');
    const gateway = new ShopifyInstructorGateway(shopify.client);

    await expect(gateway.findEntryById(entry.id)).resolves.toEqual({
      id: entry.id,
      handle: 'lele',
      ssmsId: 'abc',
    });
    await expect(gateway.findEntryById(legacy.id)).resolves.toBeNull();
    await expect(
      gateway.findEntryById('gid://shopify/Metaobject/999'),
    ).resolves.toBeNull();
  });

  it('finds the entry carrying an SSMS id across pages, preferring the oldest ACTIVE one', async () => {
    const shopify = new FakeShopify();
    const node = (id: string, status: string, createdAt: string) => ({
      id,
      handle: `h-${id}`,
      createdAt,
      capabilities: { publishable: { status } },
      ssmsId: { value: 'abc' },
    });
    shopify.on('SsmsInstructorEntries', (v) =>
      v.after == null
        ? {
            metaobjects: {
              pageInfo: { hasNextPage: true, endCursor: 'c1' },
              nodes: [
                node('draft-old', 'DRAFT', '2026-01-01T00:00:00Z'),
                {
                  ...node('other', 'ACTIVE', '2025-01-01T00:00:00Z'),
                  ssmsId: null,
                },
              ],
            },
          }
        : {
            metaobjects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                node('active-new', 'ACTIVE', '2026-03-01T00:00:00Z'),
                node('active-old', 'ACTIVE', '2026-02-01T00:00:00Z'),
              ],
            },
          },
    );
    const gateway = new ShopifyInstructorGateway(shopify.client);

    await expect(gateway.findEntryBySsmsId('abc')).resolves.toEqual({
      id: 'active-old',
      handle: 'h-active-old',
      ssmsId: 'abc',
    });
    await expect(gateway.findEntryBySsmsId('nobody')).resolves.toBeNull();
    expect(shopify.calls.map((c) => c.variables).slice(0, 2)).toEqual([
      { type: 'ssms_instructor', first: 250, after: null },
      { type: 'ssms_instructor', first: 250, after: 'c1' },
    ]);
  });

  it('updates by id, sending a handle with a redirect only when renaming', async () => {
    const shopify = new FakeShopify();
    const entry = shopify.addEntry('instructor-3f1c2b7a');
    const gateway = new ShopifyInstructorGateway(shopify.client);

    await gateway.updateEntry(entry.id, { status: 'DRAFT' });
    await expect(
      gateway.updateEntry(entry.id, {
        handle: 'lele',
        fields: [{ key: 'name', value: 'Lele' }],
        status: 'ACTIVE',
      }),
    ).resolves.toEqual({ id: entry.id, handle: 'lele' });

    expect(shopify.calls.map((c) => c.variables)).toEqual([
      {
        id: entry.id,
        metaobject: { capabilities: { publishable: { status: 'DRAFT' } } },
      },
      {
        id: entry.id,
        metaobject: {
          handle: 'lele',
          redirectNewHandle: true,
          fields: [{ key: 'name', value: 'Lele' }],
          capabilities: { publishable: { status: 'ACTIVE' } },
        },
      },
    ]);
  });

  it('throws when an upsert returns no metaobject', async () => {
    const shopify = new FakeShopify();
    shopify.on('SsmsInstructorUpsert', () => ({
      metaobjectUpsert: { metaobject: null, userErrors: [] },
    }));
    const gateway = new ShopifyInstructorGateway(shopify.client);
    await expect(
      gateway.upsertEntry('eddie', [{ key: 'name', value: 'E' }], 'ACTIVE'),
    ).rejects.toThrow('returned no metaobject');
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
