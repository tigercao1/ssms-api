import type { PurchaseCredits } from './lessons.types';

export type CreditsErrorCode =
  | 'purchase_not_found'
  | 'purchase_inactive'
  | 'no_credits_left'
  | 'no_credits_used'
  | 'concurrent_update';

export class CreditsError extends Error {
  constructor(
    readonly code: CreditsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CreditsError';
  }
}

export function creditsRemaining(purchase: PurchaseCredits): number {
  return purchase.credits_total - purchase.credits_used;
}

function requireActive(purchase: PurchaseCredits): void {
  if (purchase.status !== 'active') {
    throw new CreditsError(
      'purchase_inactive',
      `Purchase ${purchase.id} is ${purchase.status}`,
    );
  }
}

export function consumeOne(purchase: PurchaseCredits): PurchaseCredits {
  requireActive(purchase);
  if (purchase.credits_used >= purchase.credits_total) {
    throw new CreditsError(
      'no_credits_left',
      `Purchase ${purchase.id} has no credits left`,
    );
  }
  return { ...purchase, credits_used: purchase.credits_used + 1 };
}

export function returnOne(purchase: PurchaseCredits): PurchaseCredits {
  requireActive(purchase);
  if (purchase.credits_used <= 0) {
    throw new CreditsError(
      'no_credits_used',
      `Purchase ${purchase.id} has no used credits to return`,
    );
  }
  return { ...purchase, credits_used: purchase.credits_used - 1 };
}
