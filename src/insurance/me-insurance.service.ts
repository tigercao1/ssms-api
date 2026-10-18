import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hasCode, PG_FOREIGN_KEY_VIOLATION } from '../database/db-result';
import type { OnboardingLockReason } from '../documents/documents.types';
import {
  INSTRUCTOR_PROFILE_NOT_FOUND,
  MeDocumentsService,
} from '../documents/me-documents.service';
import type { SeasonRow } from '../seasons/seasons.repository';
import { SeasonsService } from '../seasons/seasons.service';
import {
  MAX_REQUEST_LESSONS,
  type RegisterLessonDto,
  type SubmitInsuranceRequestDto,
} from './dto/insurance.dto';
import {
  byCreatedDesc,
  byLessonDateDesc,
  CAP_CENTS,
  type InsuranceRecord,
  type InsuranceRequest,
  type SeasonCoverage,
  toRecord,
  toRequest,
  totalsOf,
} from './insurance.presenters';
import {
  type InsuranceInstructorRow,
  LessonInsuranceRepository,
  type RegisterInput,
  type SubmitRequestOutcome,
} from './lesson-insurance.repository';

export type InsuranceLockReason = OnboardingLockReason;

export const WAIVER_UNCONFIRMED = '请确认每位学生的 waiver 已签署';
export const NO_SEASON_FOR_DATE = 'No season covers this date';
export const UNKNOWN_LOCATION = 'Unknown ski area';
export const LOCATION_CONFLICT = 'Choose a ski area or enter another, not both';
export const TOO_MANY_LESSONS = `A request can hold at most ${MAX_REQUEST_LESSONS} lessons`;
export const MIXED_SEASONS =
  'Every lesson in a request must be in the same season';
export const INSURANCE_PENDING =
  'Your profile is being reviewed; lesson insurance opens once an admin approves you';
export const INSURANCE_REJECTED =
  'Your profile was not approved, so lesson insurance is not available';
export const INSURANCE_ONBOARDING_INCOMPLETE =
  'Finish your onboarding documents and certifications to open lesson insurance';

const LOCK_MESSAGES: Record<InsuranceLockReason, string> = {
  pending_approval: INSURANCE_PENDING,
  rejected: INSURANCE_REJECTED,
  onboarding_incomplete: INSURANCE_ONBOARDING_INCOMPLETE,
};

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
  requests: InsuranceRequest[];
}

export interface RegisterResult {
  created: boolean;
  record: InsuranceRecord;
}

export interface SubmitRequestResult {
  created: boolean;
  request: InsuranceRequest;
}

export interface UnconfirmedWaiver {
  lessonIndex: number;
  studentIndex: number;
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
    private readonly documents: MeDocumentsService,
  ) {}

  async overview(authUserId: string, seasonKey?: string): Promise<MyInsurance> {
    const instructor = await this.instructorFor(authUserId);
    const season = seasonKey
      ? await this.seasons.assertKnown(seasonKey)
      : await this.seasons.current();
    const lockReason = await this.lockFor(instructor);
    const open = lockReason === null && season;
    const [rows, requests] = open
      ? await Promise.all([
          this.repo.recordsFor(instructor.id, season.key),
          this.repo.requestsFor(instructor.id, season.key),
        ])
      : [[], []];
    return {
      locked: lockReason !== null,
      lockReason,
      season: toSeason(season),
      capCents: CAP_CENTS,
      ...totalsOf(rows),
      records: rows
        .filter((row) => row.request_id === null)
        .sort(byLessonDateDesc)
        .map(toRecord),
      requests: [...requests].sort(byCreatedDesc).map(toRequest),
    };
  }

  async submitRequest(
    authUserId: string,
    dto: SubmitInsuranceRequestDto,
  ): Promise<SubmitRequestResult> {
    const instructor = await this.approvedInstructorFor(authUserId);
    if (dto.lessons.length > MAX_REQUEST_LESSONS) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'too_many_lessons',
        message: TOO_MANY_LESSONS,
        maxLessons: MAX_REQUEST_LESSONS,
      });
    }
    const unconfirmed: UnconfirmedWaiver[] = dto.lessons.flatMap(
      (lesson, lessonIndex) =>
        lesson.students.flatMap((student, studentIndex) =>
          student.waiverConfirmed ? [] : [{ lessonIndex, studentIndex }],
        ),
    );
    if (unconfirmed.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'waiver_unconfirmed',
        message: WAIVER_UNCONFIRMED,
        indexes: unconfirmed,
      });
    }
    const lessons = dto.lessons.map((lesson) => ({
      lessonDate: lesson.lessonDate,
      durationHours: lesson.durationHours,
      locationId: lesson.locationId ?? null,
      locationOther: lesson.locationOther ? lesson.locationOther : null,
      students: lesson.students.map((s) => ({
        name: s.name,
        waiverConfirmed: true,
      })),
    }));
    const conflict = lessons.findIndex(
      (lesson) => lesson.locationId && lesson.locationOther,
    );
    if (conflict >= 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'location_conflict',
        message: LOCATION_CONFLICT,
        lessonIndex: conflict,
      });
    }
    let outcome: SubmitRequestOutcome;
    try {
      outcome = await this.repo.submitRequest({
        instructorId: instructor.id,
        seasonKey: null,
        lessons,
        idempotencyKey: dto.idempotencyKey,
        actor: authUserId,
      });
    } catch (err) {
      if (hasCode(err, PG_FOREIGN_KEY_VIOLATION)) {
        throw new BadRequestException(UNKNOWN_LOCATION);
      }
      throw err;
    }
    switch (outcome.outcome) {
      case 'no_season':
        throw new BadRequestException({
          statusCode: 400,
          code: 'no_season',
          message: NO_SEASON_FOR_DATE,
          lessonIndex: outcome.lesson_index ?? null,
        });
      case 'mixed_seasons':
        throw new BadRequestException({
          statusCode: 400,
          code: 'mixed_seasons',
          message: MIXED_SEASONS,
          lessonIndex: outcome.lesson_index,
          seasonKey: outcome.season_key,
        });
      case 'too_many_lessons':
        throw new BadRequestException({
          statusCode: 400,
          code: 'too_many_lessons',
          message: TOO_MANY_LESSONS,
          maxLessons: MAX_REQUEST_LESSONS,
        });
    }
    const row = await this.repo.findRequest(outcome.id);
    if (!row || row.instructor_id !== instructor.id) {
      throw new Error(`Insurance request ${outcome.id} not found`);
    }
    return {
      created: outcome.outcome === 'created',
      request: toRequest(row),
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
    const reason = await this.lockFor(instructor);
    if (reason) {
      throw new ForbiddenException({ message: LOCK_MESSAGES[reason], reason });
    }
    return instructor;
  }

  private lockFor(
    instructor: InsuranceInstructorRow,
  ): Promise<InsuranceLockReason | null> {
    return this.documents.onboardingLockFor(instructor, this.seasons.today());
  }
}
