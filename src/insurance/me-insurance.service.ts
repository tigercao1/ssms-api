import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hasCode, PG_FOREIGN_KEY_VIOLATION } from '../database/db-result';
import { INSTRUCTOR_PROFILE_NOT_FOUND } from '../documents/me-documents.service';
import type { SeasonRow } from '../seasons/seasons.repository';
import { SeasonsService } from '../seasons/seasons.service';
import type { RegisterLessonDto } from './dto/insurance.dto';
import {
  byLessonDateDesc,
  CAP_CENTS,
  type InsuranceRecord,
  type SeasonCoverage,
  toRecord,
  totalsOf,
} from './insurance.presenters';
import {
  type InsuranceInstructorRow,
  LessonInsuranceRepository,
  type RegisterInput,
} from './lesson-insurance.repository';

export type InsuranceLockReason = 'pending_approval' | 'rejected';

export const WAIVER_UNCONFIRMED = '请确认每位学生的 waiver 已签署';
export const NO_SEASON_FOR_DATE = 'No season covers this date';
export const UNKNOWN_LOCATION = 'Unknown ski area';
export const LOCATION_CONFLICT = 'Choose a ski area or enter another, not both';
export const INSURANCE_PENDING =
  'Your profile is being reviewed; lesson insurance opens once an admin approves you';
export const INSURANCE_REJECTED =
  'Your profile was not approved, so lesson insurance is not available';

export interface MyInsuranceSeason {
  key: string;
  startsOn: string;
  endsOn: string;
}

export interface MyInsurance {
  locked: boolean;
  lockReason: InsuranceLockReason | null;
  season: MyInsuranceSeason | null;
  capCents: number;
  owedCents: number;
  paidCents: number;
  unpaidCents: number;
  coverage: SeasonCoverage;
  records: InsuranceRecord[];
}

export interface RegisterResult {
  created: boolean;
  record: InsuranceRecord;
}

function lockFor(
  instructor: InsuranceInstructorRow,
): InsuranceLockReason | null {
  if (instructor.approval_status === 'approved') {
    return null;
  }
  return instructor.approval_status === 'rejected'
    ? 'rejected'
    : 'pending_approval';
}

function toSeason(row: SeasonRow | null): MyInsuranceSeason | null {
  return row
    ? { key: row.key, startsOn: row.starts_on, endsOn: row.ends_on }
    : null;
}

@Injectable()
export class MeInsuranceService {
  constructor(
    private readonly repo: LessonInsuranceRepository,
    private readonly seasons: SeasonsService,
  ) {}

  async overview(authUserId: string, seasonKey?: string): Promise<MyInsurance> {
    const instructor = await this.instructorFor(authUserId);
    const season = seasonKey
      ? await this.seasons.assertKnown(seasonKey)
      : await this.seasons.current();
    const lockReason = lockFor(instructor);
    const rows =
      lockReason === null && season
        ? await this.repo.recordsFor(instructor.id, season.key)
        : [];
    return {
      locked: lockReason !== null,
      lockReason,
      season: toSeason(season),
      capCents: CAP_CENTS,
      ...totalsOf(rows),
      records: [...rows].sort(byLessonDateDesc).map(toRecord),
    };
  }

  async registerLesson(
    authUserId: string,
    dto: RegisterLessonDto,
  ): Promise<RegisterResult> {
    const instructor = await this.approvedInstructorFor(authUserId);
    const unconfirmed = dto.students
      .map((student, index) => (student.waiverConfirmed ? null : index))
      .filter((index): index is number => index !== null);
    if (unconfirmed.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'waiver_unconfirmed',
        message: WAIVER_UNCONFIRMED,
        indexes: unconfirmed,
      });
    }
    const locationOther = dto.locationOther ? dto.locationOther : null;
    if (dto.locationId && locationOther) {
      throw new BadRequestException(LOCATION_CONFLICT);
    }
    return this.register({
      instructorId: instructor.id,
      kind: 'lesson',
      seasonKey: null,
      lessonDate: dto.lessonDate,
      durationHours: dto.durationHours,
      locationId: dto.locationId ?? null,
      locationOther,
      students: dto.students.map((s) => ({
        name: s.name,
        waiverConfirmed: true,
      })),
      idempotencyKey: dto.idempotencyKey,
      actor: authUserId,
    });
  }

  private async register(input: RegisterInput): Promise<RegisterResult> {
    let outcome: Awaited<ReturnType<LessonInsuranceRepository['register']>>;
    try {
      outcome = await this.repo.register(input);
    } catch (err) {
      if (hasCode(err, PG_FOREIGN_KEY_VIOLATION)) {
        throw new BadRequestException(UNKNOWN_LOCATION);
      }
      throw err;
    }
    if (outcome.outcome === 'no_season') {
      throw new BadRequestException({
        statusCode: 400,
        code: 'no_season',
        message: NO_SEASON_FOR_DATE,
      });
    }
    if (outcome.outcome !== 'created' && outcome.outcome !== 'existing') {
      throw new Error(`Unexpected insurance outcome ${outcome.outcome}`);
    }
    const row = await this.repo.findRecord(outcome.id);
    if (!row || row.instructor_id !== input.instructorId) {
      throw new Error(`Insurance record ${outcome.id} not found`);
    }
    return {
      created: outcome.outcome === 'created',
      record: toRecord(row),
    };
  }

  private async instructorFor(
    authUserId: string,
  ): Promise<InsuranceInstructorRow> {
    const instructor = await this.repo.instructorByAuthUser(authUserId);
    if (!instructor) {
      throw new NotFoundException(INSTRUCTOR_PROFILE_NOT_FOUND);
    }
    return instructor;
  }

  private async approvedInstructorFor(
    authUserId: string,
  ): Promise<InsuranceInstructorRow> {
    const instructor = await this.instructorFor(authUserId);
    const reason = lockFor(instructor);
    if (reason) {
      throw new ForbiddenException({
        message: reason === 'rejected' ? INSURANCE_REJECTED : INSURANCE_PENDING,
        reason,
      });
    }
    return instructor;
  }
}
