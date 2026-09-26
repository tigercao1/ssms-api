import { assertNoUserErrors } from './shopify-user-errors';
import { ShopifyError, ShopifyUserErrorsError } from './shopify.errors';

describe('assertNoUserErrors', () => {
  it('returns the payload when userErrors is empty', () => {
    const payload = { metaobject: { id: 'gid://1' }, userErrors: [] };
    expect(assertNoUserErrors('metaobjectUpdate', payload)).toBe(payload);
  });

  it('throws a typed error listing every user error', () => {
    const userErrors = [
      { field: ['metaobject', 'fields', '0'], message: 'Value is invalid' },
      { field: null, message: 'Handle is taken', code: 'TAKEN' },
    ];
    let error: unknown;
    try {
      assertNoUserErrors('metaobjectUpsert', { metaobject: null, userErrors });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ShopifyUserErrorsError);
    expect((error as ShopifyUserErrorsError).userErrors).toEqual(userErrors);
    expect((error as ShopifyUserErrorsError).operation).toBe(
      'metaobjectUpsert',
    );
    expect((error as Error).message).toBe(
      'metaobjectUpsert returned user errors: metaobject.fields.0: Value is invalid; Handle is taken',
    );
  });

  it('throws when the mutation payload is missing', () => {
    expect(() => assertNoUserErrors('fileCreate', null)).toThrow(ShopifyError);
  });
});
