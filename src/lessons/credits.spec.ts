import {
  consumeOne,
  CreditsError,
  creditsRemaining,
  returnOne,
} from './credits';
import type { PurchaseCredits } from './lessons.types';

const purchase = (
  overrides: Partial<PurchaseCredits> = {},
): PurchaseCredits => ({
  id: 'p-1',
  credits_total: 4,
  credits_used: 0,
  status: 'active',
  ...overrides,
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof CreditsError ? err.code : 'unexpected';
  }
  return undefined;
};

describe('credit rules', () => {
  it('uses a four-pack one session at a time down to zero', () => {
    let p = purchase();
    for (let used = 1; used <= 4; used++) {
      p = consumeOne(p);
      expect(p.credits_used).toBe(used);
      expect(creditsRemaining(p)).toBe(4 - used);
    }
    expect(codeOf(() => consumeOne(p))).toBe('no_credits_left');
  });

  it('never goes over the total, even from bad data', () => {
    expect(codeOf(() => consumeOne(purchase({ credits_used: 5 })))).toBe(
      'no_credits_left',
    );
    expect(codeOf(() => consumeOne(purchase({ credits_total: 0 })))).toBe(
      'no_credits_left',
    );
  });

  it('returns a credit and never goes negative', () => {
    const p = returnOne(purchase({ credits_used: 1 }));
    expect(p.credits_used).toBe(0);
    expect(codeOf(() => returnOne(p))).toBe('no_credits_used');
  });

  it.each(['refunded', 'void'] as const)(
    'refuses to move credits on a %s purchase',
    (status) => {
      const p = purchase({ status, credits_used: 1 });
      expect(codeOf(() => consumeOne(p))).toBe('purchase_inactive');
      expect(codeOf(() => returnOne(p))).toBe('purchase_inactive');
    },
  );

  it('does not mutate its input', () => {
    const p = purchase();
    consumeOne(p);
    expect(p.credits_used).toBe(0);
  });
});
