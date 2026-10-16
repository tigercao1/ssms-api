import { ConfigService } from '@nestjs/config';
import {
  DatabaseError,
  PG_EXCLUSION_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from '../../src/database/db-result';
import {
  type SeasonDatesPatch,
  type SeasonRow,
  SeasonsRepository,
} from '../../src/seasons/seasons.repository';
import {
  SEASON_CLOCK,
  SeasonsService,
} from '../../src/seasons/seasons.service';

export const SEASON_2026: SeasonRow = {
  key: '2026/27',
  starts_on: '2026-11-01',
  ends_on: '2027-04-30',
};

export function seasonRow(key: string): SeasonRow {
  const year = Number(key.slice(0, 4));
  return {
    key,
    starts_on: `${year}-11-01`,
    ends_on: `${year + 1}-04-30`,
  };
}

export function seasonsRepo(...keys: string[]): InMemorySeasonsRepository {
  return new InMemorySeasonsRepository(keys.map(seasonRow));
}

export class InMemorySeasonsRepository extends SeasonsRepository {
  readonly rows = new Map<string, SeasonRow>();
  readonly references = new Map<string, number>();

  constructor(seed: SeasonRow[] = [SEASON_2026]) {
    super();
    for (const row of seed) this.rows.set(row.key, { ...row });
  }

  list(): Promise<SeasonRow[]> {
    return Promise.resolve([...this.rows.values()].map((row) => ({ ...row })));
  }

  insert(row: SeasonRow): Promise<SeasonRow> {
    if (this.rows.has(row.key)) {
      return Promise.reject(
        new DatabaseError('create season', PG_UNIQUE_VIOLATION, 'duplicate'),
      );
    }
    this.assertNoOverlap(row);
    this.rows.set(row.key, { ...row });
    return Promise.resolve({ ...row });
  }

  update(key: string, patch: SeasonDatesPatch): Promise<SeasonRow | null> {
    const current = this.rows.get(key);
    if (!current) return Promise.resolve(null);
    const next = { ...current, ...patch };
    this.assertNoOverlap(next);
    this.rows.set(key, next);
    return Promise.resolve({ ...next });
  }

  delete(key: string): Promise<SeasonRow | null> {
    const current = this.rows.get(key) ?? null;
    this.rows.delete(key);
    return Promise.resolve(current);
  }

  referenceCount(key: string): Promise<number> {
    return Promise.resolve(this.references.get(key) ?? 0);
  }

  private assertNoOverlap(row: SeasonRow): void {
    for (const other of this.rows.values()) {
      if (
        other.key !== row.key &&
        other.starts_on <= row.ends_on &&
        row.starts_on <= other.ends_on
      ) {
        throw new DatabaseError(
          'save season',
          PG_EXCLUSION_VIOLATION,
          'overlap',
        );
      }
    }
  }
}

export function seasonsProviders(
  repo: InMemorySeasonsRepository = new InMemorySeasonsRepository(),
  now: () => Date = () => new Date('2026-10-15T16:00:00Z'),
) {
  return [
    SeasonsService,
    { provide: SeasonsRepository, useValue: repo },
    { provide: SEASON_CLOCK, useValue: now },
  ];
}

export function seasonsService(
  repo: InMemorySeasonsRepository = new InMemorySeasonsRepository(),
  env: Record<string, string | undefined> = {},
  now: () => Date = () => new Date('2026-10-15T16:00:00Z'),
): SeasonsService {
  return new SeasonsService(
    repo,
    { get: (k: string) => env[k] } as unknown as ConfigService,
    { record: () => Promise.resolve() } as never,
    now,
  );
}
