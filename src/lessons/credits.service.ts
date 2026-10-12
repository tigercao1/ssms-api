import { Injectable } from '@nestjs/common';
import {
  consumeOne,
  CreditsError,
  creditsRemaining,
  returnOne,
} from './credits';
import type { PurchaseCredits } from './lessons.types';
import { PurchaseCreditsRepository } from './purchase-credits.repository';

export const MAX_CREDIT_ATTEMPTS = 3;

export interface CreditBalance {
  purchaseId: string;
  creditsTotal: number;
  creditsUsed: number;
  creditsRemaining: number;
}

@Injectable()
export class CreditsService {
  constructor(private readonly repo: PurchaseCreditsRepository) {}

  consumeCredit(purchaseId: string): Promise<CreditBalance> {
    return this.apply(purchaseId, consumeOne);
  }

  returnCredit(purchaseId: string): Promise<CreditBalance> {
    return this.apply(purchaseId, returnOne);
  }

  private async apply(
    purchaseId: string,
    step: (purchase: PurchaseCredits) => PurchaseCredits,
  ): Promise<CreditBalance> {
    for (let attempt = 1; attempt <= MAX_CREDIT_ATTEMPTS; attempt++) {
      const current = await this.repo.find(purchaseId);
      if (!current) {
        throw new CreditsError(
          'purchase_not_found',
          `Purchase ${purchaseId} not found`,
        );
      }
      const next = step(current);
      const saved = await this.repo.setCreditsUsed(
        purchaseId,
        current.credits_used,
        next.credits_used,
      );
      if (saved) {
        return toBalance(saved);
      }
    }
    throw new CreditsError(
      'concurrent_update',
      `Purchase ${purchaseId} kept changing; try again`,
    );
  }
}

function toBalance(purchase: PurchaseCredits): CreditBalance {
  return {
    purchaseId: purchase.id,
    creditsTotal: purchase.credits_total,
    creditsUsed: purchase.credits_used,
    creditsRemaining: creditsRemaining(purchase),
  };
}
