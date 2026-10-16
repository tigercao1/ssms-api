import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import {
  hasCode,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from '../database/db-result';
import { torontoToday } from '../documents/certification-validity';
import { currentSeasonOn, seasonContaining } from './current-season';
import { type SeasonRow, SeasonsRepository } from './seasons.repository';

export const SEASON_CLOCK = Symbol('SEASON_CLOCK');
export const UNKNOWN_SEASON = 'Unknown season';
export const SEASON_OVERLAP = 'Season dates overlap another season';
export const SEASON_IN_USE = 'Season is in use and cannot be deleted';
export const SEASON_RANGE = 'endsOn must be after startsOn';
export const SEASON_DATES_REQUIRED = 'Provide startsOn or endsOn';

export interface Season {
  key: string;
  startsOn: string;
  endsOn: string;
  isCurrent: boolean;
}

export interface AdminSeason extends Season {
  inUse: boolean;
}

export interface SeasonDates {
  startsOn?: string;
  endsOn?: string;
}

export interface NewSeason {
  key: string;
  startsOn: string;
  endsOn: string;
}

@Injectable()
export class SeasonsService {
  private readonly logger = new Logger(SeasonsService.name);
  private readonly now: () => Date;

  constructor(
    private readonly repo: SeasonsRepository,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    @Optional() @Inject(SEASON_CLOCK) clock?: () => Date,
  ) {
    this.now = clock ?? (() => new Date());
  }

  today(): string {
    return torontoToday(this.now());
  }

  async list(): Promise<Season[]> {
    const rows = await this.repo.list();
    const current = this.pickCurrent(rows);
    return sortNewestFirst(rows).map((row) => toSeason(row, current));
  }

  async current(): Promise<SeasonRow | null> {
    return this.pickCurrent(await this.repo.list());
  }

  async currentKey(): Promise<string | null> {
    return (await this.current())?.key ?? null;
  }

  async find(key: string): Promise<SeasonRow | null> {
    return (await this.repo.list()).find((row) => row.key === key) ?? null;
  }

  async assertKnown(key: string): Promise<SeasonRow> {
    const row = await this.find(key);
    if (!row) {
      throw new BadRequestException(UNKNOWN_SEASON);
    }
    return row;
  }

  async containing(date: string): Promise<SeasonRow | null> {
    return seasonContaining(await this.repo.list(), date);
  }

  async adminList(): Promise<AdminSeason[]> {
    const rows = await this.repo.list();
    const current = this.pickCurrent(rows);
    return Promise.all(
      sortNewestFirst(rows).map(async (row) => ({
        ...toSeason(row, current),
        inUse: (await this.repo.referenceCount(row.key)) > 0,
      })),
    );
  }

  async create(input: NewSeason, actor: AuditActor): Promise<AdminSeason> {
    assertRange(input.startsOn, input.endsOn);
    let row: SeasonRow;
    try {
      row = await this.repo.insert({
        key: input.key,
        starts_on: input.startsOn,
        ends_on: input.endsOn,
      });
    } catch (err) {
      if (hasCode(err, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(`Season '${input.key}' already exists`);
      }
      throw overlapOr(err);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.seasonCreate,
      actor: { ...actor, role: 'admin' },
      targetType: 'season',
      metadata: { key: row.key, startsOn: row.starts_on, endsOn: row.ends_on },
    });
    return this.present(row);
  }

  async update(
    key: string,
    input: SeasonDates,
    actor: AuditActor,
  ): Promise<AdminSeason> {
    if (input.startsOn === undefined && input.endsOn === undefined) {
      throw new BadRequestException(SEASON_DATES_REQUIRED);
    }
    const before = await this.findOrThrow(key);
    assertRange(
      input.startsOn ?? before.starts_on,
      input.endsOn ?? before.ends_on,
    );
    let row: SeasonRow | null;
    try {
      row = await this.repo.update(key, {
        ...(input.startsOn === undefined ? {} : { starts_on: input.startsOn }),
        ...(input.endsOn === undefined ? {} : { ends_on: input.endsOn }),
      });
    } catch (err) {
      throw overlapOr(err);
    }
    if (!row) {
      throw notFound(key);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.seasonUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'season',
      metadata: {
        key,
        from: { startsOn: before.starts_on, endsOn: before.ends_on },
        to: { startsOn: row.starts_on, endsOn: row.ends_on },
      },
    });
    return this.present(row);
  }

  async remove(key: string, actor: AuditActor): Promise<AdminSeason> {
    await this.findOrThrow(key);
    if ((await this.repo.referenceCount(key)) > 0) {
      throw new ConflictException(SEASON_IN_USE);
    }
    let row: SeasonRow | null;
    try {
      row = await this.repo.delete(key);
    } catch (err) {
      if (hasCode(err, PG_FOREIGN_KEY_VIOLATION)) {
        throw new ConflictException(SEASON_IN_USE);
      }
      throw err;
    }
    if (!row) {
      throw notFound(key);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.seasonDelete,
      actor: { ...actor, role: 'admin' },
      targetType: 'season',
      metadata: { key, startsOn: row.starts_on, endsOn: row.ends_on },
    });
    return { ...toSeason(row, null), inUse: false };
  }

  private async present(row: SeasonRow): Promise<AdminSeason> {
    const [current, references] = await Promise.all([
      this.current(),
      this.repo.referenceCount(row.key),
    ]);
    return { ...toSeason(row, current), inUse: references > 0 };
  }

  private async findOrThrow(key: string): Promise<SeasonRow> {
    const row = await this.find(key);
    if (!row) {
      throw notFound(key);
    }
    return row;
  }

  private pickCurrent(rows: readonly SeasonRow[]): SeasonRow | null {
    const configured = this.config.get<string>('CURRENT_SEASON')?.trim();
    if (configured) {
      const match = rows.find((row) => row.key === configured);
      if (match) {
        return match;
      }
      this.logger.warn(
        `CURRENT_SEASON '${configured}' is not a known season; ignoring it`,
      );
    }
    return currentSeasonOn(rows, this.today());
  }
}

function toSeason(row: SeasonRow, current: SeasonRow | null): Season {
  return {
    key: row.key,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    isCurrent: current?.key === row.key,
  };
}

function sortNewestFirst(rows: readonly SeasonRow[]): SeasonRow[] {
  return [...rows].sort(
    (a, b) =>
      b.starts_on.localeCompare(a.starts_on) || b.key.localeCompare(a.key),
  );
}

function assertRange(startsOn: string, endsOn: string): void {
  if (endsOn <= startsOn) {
    throw new BadRequestException(SEASON_RANGE);
  }
}

function overlapOr(err: unknown): Error {
  if (hasCode(err, PG_EXCLUSION_VIOLATION)) {
    return new ConflictException(SEASON_OVERLAP);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function notFound(key: string): NotFoundException {
  return new NotFoundException(`No season '${key}'`);
}
