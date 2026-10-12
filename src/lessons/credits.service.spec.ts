import { CreditsError } from './credits';
import { CreditsService, MAX_CREDIT_ATTEMPTS } from './credits.service';
import type { PurchaseCredits } from './lessons.types';
import { PurchaseCreditsRepository } from './purchase-credits.repository';

class InMemoryPurchases extends PurchaseCreditsRepository {
  rows = new Map<string, PurchaseCredits>();
  interfere = 0;

  find(id: string): Promise<PurchaseCredits | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? { ...row } : null);
  }

  setCreditsUsed(
    id: string,
    expectedUsed: number,
    nextUsed: number,
  ): Promise<PurchaseCredits | null> {
    const row = this.rows.get(id);
    if (row && this.interfere > 0) {
      this.interfere--;
      row.credits_used = Math.min(row.credits_used + 1, row.credits_total);
      return Promise.resolve(null);
    }
    if (!row || row.credits_used !== expectedUsed || row.status !== 'active') {
      return Promise.resolve(null);
    }
    if (nextUsed < 0 || nextUsed > row.credits_total) {
      return Promise.reject(new Error('purchases_credits_used_check'));
    }
    row.credits_used = nextUsed;
    return Promise.resolve({ ...row });
  }
}

function setup(row: Partial<PurchaseCredits> = {}) {
  const repo = new InMemoryPurchases();
  repo.rows.set('p-1', {
    id: 'p-1',
    credits_total: 4,
    credits_used: 0,
    status: 'active',
    ...row,
  });
  return { repo, service: new CreditsService(repo) };
}

const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (err: unknown) => (err instanceof CreditsError ? err.code : 'unexpected'),
  );

describe('CreditsService', () => {
  it('consumes and returns credits and reports the balance', async () => {
    const { service, repo } = setup();
    await expect(service.consumeCredit('p-1')).resolves.toEqual({
      purchaseId: 'p-1',
      creditsTotal: 4,
      creditsUsed: 1,
      creditsRemaining: 3,
    });
    await service.consumeCredit('p-1');
    await expect(service.returnCredit('p-1')).resolves.toMatchObject({
      creditsUsed: 1,
      creditsRemaining: 3,
    });
    expect(repo.rows.get('p-1')?.credits_used).toBe(1);
  });

  it('stops at the total', async () => {
    const { service } = setup({ credits_used: 4 });
    expect(await code(service.consumeCredit('p-1'))).toBe('no_credits_left');
  });

  it('stops at zero', async () => {
    const { service } = setup();
    expect(await code(service.returnCredit('p-1'))).toBe('no_credits_used');
  });

  it('rejects an unknown purchase', async () => {
    const { service } = setup();
    expect(await code(service.consumeCredit('missing'))).toBe(
      'purchase_not_found',
    );
  });

  it('rejects a refunded purchase', async () => {
    const { service } = setup({ status: 'refunded', credits_used: 1 });
    expect(await code(service.returnCredit('p-1'))).toBe('purchase_inactive');
  });

  it('re-reads after a concurrent change and applies the rule to fresh data', async () => {
    const { service, repo } = setup({ credits_used: 2 });
    repo.interfere = 1;
    await expect(service.consumeCredit('p-1')).resolves.toMatchObject({
      creditsUsed: 4,
    });
    repo.interfere = 0;
    expect(await code(service.consumeCredit('p-1'))).toBe('no_credits_left');
  });

  it('gives up after repeated concurrent changes', async () => {
    const { service, repo } = setup({ credits_total: 10 });
    repo.interfere = MAX_CREDIT_ATTEMPTS;
    expect(await code(service.consumeCredit('p-1'))).toBe('concurrent_update');
    expect(repo.rows.get('p-1')?.credits_used).toBe(MAX_CREDIT_ATTEMPTS);
  });
});
