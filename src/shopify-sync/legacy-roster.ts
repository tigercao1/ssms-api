import { Injectable } from '@nestjs/common';
import {
  type LegacyEntryName,
  scoreNames,
} from '../shopify/legacy-pairing/name-matching';
import type { GoLiveHold } from './go-live';
import { InstructorSyncRepository } from './instructor-sync.repository';
import type {
  InstructorShopifyState,
  SyncInstructorRow,
} from './instructor-sync.types';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';

export const LEGACY_ROSTER_TTL_MS = 5 * 60_000;
export const STRONG_MATCH_SCORE = 1;

export class LegacyRosterUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `Legacy our_team entries are unavailable, so no handle is claimed and no unpaired instructor is published: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'LegacyRosterUnavailableError';
  }
}

export function strongLegacyMatches(
  instructor: Pick<SyncInstructorRow, 'display_name_en' | 'display_name_zh'>,
  entries: LegacyEntryName[],
): LegacyEntryName[] {
  return entries.filter(
    (entry) =>
      scoreNames(
        entry.name,
        instructor.display_name_en,
        instructor.display_name_zh,
      ) >= STRONG_MATCH_SCORE,
  );
}

@Injectable()
export class LegacyRoster {
  private cached?: { entries: LegacyEntryName[]; fetchedAt: number };
  private pending?: Promise<LegacyEntryName[]>;

  constructor(
    private readonly gateway: ShopifyInstructorGateway,
    private readonly repo: InstructorSyncRepository,
  ) {}

  async entries(): Promise<LegacyEntryName[]> {
    if (
      this.cached &&
      Date.now() - this.cached.fetchedAt < LEGACY_ROSTER_TTL_MS
    ) {
      return this.cached.entries;
    }
    this.pending ??= this.fetch().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async handles(): Promise<Set<string>> {
    return new Set((await this.entries()).map((entry) => entry.handle));
  }

  async holdFor(
    instructor: SyncInstructorRow,
    state: InstructorShopifyState | null,
  ): Promise<GoLiveHold | null> {
    const entries = await this.entries();
    const stored = state?.shopify_handle;
    if (stored && entries.some((entry) => entry.handle === stored)) {
      return null;
    }
    const dismissed = new Set(state?.dismissed_legacy_handles ?? []);
    for (const entry of strongLegacyMatches(instructor, entries)) {
      if (dismissed.has(entry.handle)) {
        continue;
      }
      if (await this.repo.isHandleStoredByOther(entry.handle, instructor.id)) {
        continue;
      }
      return {
        reason: 'legacy_pairing_decision',
        legacyHandle: entry.handle,
        legacyName: entry.name,
        message: `needs legacy pairing decision: ${entry.handle}`,
      };
    }
    return null;
  }

  private async fetch(): Promise<LegacyEntryName[]> {
    try {
      const entries = await this.gateway.listLegacyEntries();
      this.cached = { entries, fetchedAt: Date.now() };
      return entries;
    } catch (err) {
      throw new LegacyRosterUnavailableError(err);
    }
  }
}
