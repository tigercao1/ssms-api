import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { torontoToday } from '../documents/certification-validity';
import type { OnboardingLockReason } from '../documents/documents.types';
import {
  INSTRUCTOR_PROFILE_NOT_FOUND,
  MeDocumentsService,
} from '../documents/me-documents.service';
import type { RateUnit } from '../lessons/pay-rates';
import { toPayRate } from '../lessons/pay-rates.service';
import {
  ALREADY_PAID,
  type AmountLine,
  type ClassLine,
  classLine,
  instructorTotals,
  NEEDS_RATE,
} from './payroll-lines';
import { localDate, localTime, periodContaining } from './payroll-time';
import {
  type InstructorClassRow,
  type InstructorLineRow,
  type ParticipantEmbed,
  type PayrollPeriodRow,
  PayrollRepository,
} from './payroll.repository';
import { PAYROLL_CLOCK, storedLine, toPayable } from './payroll.service';

export type LockReason = OnboardingLockReason;
export type MyLessonStatus = 'scheduled' | 'completed' | 'no_show';

export interface MyLesson {
  classId: string;
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  status: MyLessonStatus;
  lessonTypeNameEn: string | null;
  lessonTypeNameZh: string | null;
  locationName: string | null;
  students: string[];
  minutes: number;
  rate: number | null;
  rateUnit: RateUnit;
  currency: string;
  amount: number | null;
  needsRate: boolean;
}

export interface MyAdjustment {
  id: string;
  description: string;
  amount: number;
  currency: string;
}

export interface MyPeriodTotal {
  currency: string;
  lessons: number;
  minutes: number;
  lessonAmount: number;
  adjustmentAmount: number;
  total: number;
  needsRateCount: number;
}

export interface MyPayPeriod {
  startsOn: string;
  endsOn: string;
  status: 'awaiting' | 'paid';
  finalizedAt: string | null;
  lessons: MyLesson[];
  adjustments: MyAdjustment[];
  totals: MyPeriodTotal[];
}

export interface MyProjectedTotal {
  currency: string;
  amount: number;
  lessons: number;
}

export interface MyLessonsResponse {
  locked: boolean;
  lockReason: LockReason | null;
  upcoming: {
    lessons: MyLesson[];
    projected: MyProjectedTotal[];
    needsRateCount: number;
  };
  periods: MyPayPeriod[];
}

interface LessonDetails {
  lessonTypeNameEn: string | null;
  lessonTypeNameZh: string | null;
  locationName: string | null;
  students: string[];
}

export function studentName(
  firstName: string | null,
  lastName: string | null,
): string | null {
  const first = firstName?.trim() ?? '';
  const last = lastName?.trim() ?? '';
  if (last.length === 0) {
    return first.length > 0 ? first : null;
  }
  const initial = `${[...last][0].toUpperCase()}.`;
  return first.length > 0 ? `${first} ${initial}` : initial;
}

function studentsOf(participants: ParticipantEmbed[] | null): string[] {
  return (participants ?? [])
    .map((p) =>
      studentName(
        p.customer?.first_name ?? null,
        p.customer?.last_name ?? null,
      ),
    )
    .filter((name): name is string => name !== null);
}

function studentsFromNames(names: readonly string[]): string[] {
  return names
    .map((name) => {
      const parts = name.trim().split(/\s+/).filter(Boolean);
      return parts.length === 0
        ? null
        : studentName(
            parts[0],
            parts.length > 1 ? parts[parts.length - 1] : null,
          );
    })
    .filter((name): name is string => name !== null);
}

function toLesson(
  line: ClassLine,
  details: LessonDetails,
  projected: boolean,
): MyLesson {
  const needsRate = line.flags.includes(NEEDS_RATE);
  return {
    classId: line.classId,
    date: localDate(line.startsAt),
    startTime: localTime(line.startsAt),
    endTime: localTime(line.endsAt),
    startsAt: line.startsAt,
    endsAt: line.endsAt,
    status: line.classStatus as MyLessonStatus,
    ...details,
    minutes: line.minutes,
    rate: line.hourlyRate,
    rateUnit: line.rateUnit,
    currency: line.currency,
    amount: projected && needsRate ? null : line.amount,
    needsRate,
  };
}

function classDetails(row: InstructorClassRow): LessonDetails {
  return {
    lessonTypeNameEn: row.lesson_type?.name_en ?? null,
    lessonTypeNameZh: row.lesson_type?.name_zh ?? null,
    locationName: row.location?.name ?? null,
    students: studentsOf(row.participants),
  };
}

function snapshotDetails(row: InstructorLineRow): LessonDetails {
  const joined = studentsOf(row.class?.participants ?? null);
  return {
    lessonTypeNameEn: row.description,
    lessonTypeNameZh: row.lesson_type?.name_zh ?? null,
    locationName: row.class?.location?.name ?? null,
    students:
      joined.length > 0 ? joined : studentsFromNames(row.customer_names ?? []),
  };
}

function byStart(a: MyLesson, b: MyLesson): number {
  return (
    a.startsAt.localeCompare(b.startsAt) || a.classId.localeCompare(b.classId)
  );
}

function byCurrency<T extends { currency: string }>(a: T, b: T): number {
  return a.currency.localeCompare(b.currency);
}

function periodTotals(
  lines: readonly ClassLine[],
  adjustments: readonly AmountLine[],
): MyPeriodTotal[] {
  return instructorTotals(lines, adjustments)
    .map((total) => ({
      currency: total.currency,
      lessons: total.lessons,
      minutes: total.minutes,
      lessonAmount: total.lessonAmount,
      adjustmentAmount: total.adjustmentAmount,
      total: total.total,
      needsRateCount: total.needsRate,
    }))
    .sort(byCurrency);
}

function toAdjustment(row: InstructorLineRow): MyAdjustment {
  return {
    id: row.id,
    description: row.description ?? '',
    amount: Number(row.amount),
    currency: row.currency,
  };
}

const EMPTY_UPCOMING = (): MyLessonsResponse['upcoming'] => ({
  lessons: [],
  projected: [],
  needsRateCount: 0,
});

@Injectable()
export class MeLessonsService {
  private readonly now: () => Date;

  constructor(
    private readonly repo: PayrollRepository,
    private readonly documents: MeDocumentsService,
    @Optional() @Inject(PAYROLL_CLOCK) clock?: () => Date,
  ) {
    this.now = clock ?? (() => new Date());
  }

  async lessons(authUserId: string): Promise<MyLessonsResponse> {
    const instructor = await this.repo.instructorByAuthUser(authUserId);
    if (!instructor) {
      throw new NotFoundException(INSTRUCTOR_PROFILE_NOT_FOUND);
    }
    const lockReason = await this.documents.onboardingLockFor(
      instructor,
      torontoToday(this.now()),
    );
    if (
      lockReason === 'pending_approval' ||
      lockReason === 'onboarding_incomplete'
    ) {
      return {
        locked: true,
        lockReason,
        upcoming: EMPTY_UPCOMING(),
        periods: [],
      };
    }
    const now = this.now().getTime();
    const [settings, classes, lines] = await Promise.all([
      this.repo.settings(),
      this.repo.classesForInstructor(instructor.id),
      this.repo.linesForInstructor(instructor.id),
    ]);
    const lessonTypeIds = [
      ...new Set(
        classes
          .map((c) => c.lesson_type_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    const [rateRows, classLinePeriods] = await Promise.all([
      this.repo.ratesFor(lessonTypeIds),
      this.repo.classLinePeriods(classes.map((c) => c.id)),
    ]);
    const rates = rateRows.map(toPayRate);
    const paidIn = new Map<string, Set<string>>();
    for (const { class_id, period_id } of classLinePeriods) {
      const periods = paidIn.get(class_id) ?? new Set<string>();
      periods.add(period_id);
      paidIn.set(class_id, periods);
    }
    const paidOutside = (classId: string, periodId: string | null) =>
      [...(paidIn.get(classId) ?? [])].some((id) => id !== periodId);

    const project = (row: InstructorClassRow) => ({
      line: classLine(toPayable(row), rates),
      details: classDetails(row),
    });

    const upcoming = EMPTY_UPCOMING();
    if (lockReason === null) {
      const projected = classes
        .filter((c) => Date.parse(c.starts_at) >= now)
        .filter((c) => !paidOutside(c.id, null))
        .map(project);
      upcoming.lessons = projected
        .map(({ line, details }) => toLesson(line, details, true))
        .sort(byStart);
      upcoming.needsRateCount = upcoming.lessons.filter(
        (l) => l.needsRate,
      ).length;
      upcoming.projected = instructorTotals(
        projected
          .map(({ line }) => line)
          .filter((line) => !line.flags.includes(NEEDS_RATE)),
        [],
      )
        .map((total) => ({
          currency: total.currency,
          amount: total.lessonAmount,
          lessons: total.lessons,
        }))
        .sort(byCurrency);
    }

    const anchor = settings.anchor_date;
    const pastByPeriod = new Map<string, InstructorClassRow[]>();
    for (const row of classes) {
      if (Date.parse(row.starts_at) >= now) continue;
      const { startsOn } = periodContaining(anchor, localDate(row.starts_at));
      pastByPeriod.set(startsOn, [...(pastByPeriod.get(startsOn) ?? []), row]);
    }
    const periodRows = new Map<string, PayrollPeriodRow>();
    for (const line of lines) {
      if (line.period) periodRows.set(line.period.starts_on, line.period);
    }
    const missing = [...pastByPeriod.keys()].filter(
      (startsOn) => !periodRows.has(startsOn),
    );
    if (missing.length > 0) {
      for (const row of await this.repo.periodsStartingOn(missing)) {
        periodRows.set(row.starts_on, row);
      }
    }

    const keys = new Set([...pastByPeriod.keys(), ...periodRows.keys()]);
    const periods: MyPayPeriod[] = [];
    for (const startsOn of keys) {
      const row = periodRows.get(startsOn) ?? null;
      const linesIn = row ? lines.filter((l) => l.period_id === row.id) : [];
      const adjustmentRows = linesIn.filter((l) => l.kind === 'adjustment');
      let classLines: ClassLine[];
      let lessons: MyLesson[];
      if (row?.status === 'finalized') {
        const stored = linesIn
          .filter((l) => l.kind === 'class')
          .map((l) => ({ line: storedLine(l), details: snapshotDetails(l) }))
          .filter(({ line }) => !line.flags.includes(ALREADY_PAID));
        classLines = stored.map(({ line }) => line);
        lessons = stored.map(({ line, details }) =>
          toLesson(line, details, false),
        );
      } else {
        const live = (pastByPeriod.get(startsOn) ?? [])
          .filter((c) => !paidOutside(c.id, row?.id ?? null))
          .map(project);
        classLines = live.map(({ line }) => line);
        lessons = live.map(({ line, details }) =>
          toLesson(line, details, true),
        );
      }
      if (lessons.length === 0 && adjustmentRows.length === 0) continue;
      const adjustments = adjustmentRows.map(toAdjustment);
      periods.push({
        startsOn,
        endsOn: row?.ends_on ?? periodContaining(anchor, startsOn).endsOn,
        status: row?.status === 'finalized' ? 'paid' : 'awaiting',
        finalizedAt: row?.status === 'finalized' ? row.finalized_at : null,
        lessons: lessons.sort(byStart),
        adjustments,
        totals: periodTotals(
          classLines,
          adjustments.map((a) => ({ ...a, instructorId: instructor.id })),
        ),
      });
    }
    periods.sort((a, b) => b.startsOn.localeCompare(a.startsOn));
    return {
      locked: lockReason !== null,
      lockReason,
      upcoming,
      periods,
    };
  }
}
