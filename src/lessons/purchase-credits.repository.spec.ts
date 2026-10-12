import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { SupabasePurchaseCreditsRepository } from './purchase-credits.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const row = { id: ID, credits_total: 4, credits_used: 1, status: 'active' };

describe('SupabasePurchaseCreditsRepository', () => {
  it('loads a purchase or null', async () => {
    const { client } = recordingSupabase({
      purchases: [
        { data: row, error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabasePurchaseCreditsRepository(client);
    await expect(repo.find(ID)).resolves.toEqual(row);
    await expect(repo.find(ID)).resolves.toBeNull();
  });

  it('writes credits_used only if it still has the expected value on an active purchase', async () => {
    const { client, queries } = recordingSupabase({
      purchases: [
        { data: [{ ...row, credits_used: 2 }], error: null },
        { data: [], error: null },
      ],
    });
    const repo = new SupabasePurchaseCreditsRepository(client);
    await expect(repo.setCreditsUsed(ID, 1, 2)).resolves.toMatchObject({
      credits_used: 2,
    });
    await expect(repo.setCreditsUsed(ID, 1, 2)).resolves.toBeNull();
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['update', { credits_used: 2 }],
        ['eq', 'id', ID],
        ['eq', 'credits_used', 1],
        ['eq', 'status', 'active'],
      ]),
    );
  });

  it('surfaces database errors', async () => {
    const fail = { data: null, error: { message: 'boom' } };
    const { client } = recordingSupabase({ purchases: [fail, fail] });
    const repo = new SupabasePurchaseCreditsRepository(client);
    await expect(repo.find(ID)).rejects.toThrow(
      'Failed to load purchase: boom',
    );
    await expect(repo.setCreditsUsed(ID, 0, 1)).rejects.toThrow(
      'Failed to update purchase credits: boom',
    );
  });
});
