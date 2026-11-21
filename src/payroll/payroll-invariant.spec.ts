import {
  ADA_ID,
  BO_ID,
  GROUP_60,
  InMemoryPayrollRepository,
  PRIVATE_90,
} from '../../test/helpers/payroll-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import type { AuditService } from '../audit/audit.service';
import type { MeDocumentsService } from '../documents/me-documents.service';
import { MeLessonsService } from './me-lessons.service';
import {
  ADJUSTED,
  ALREADY_PAID,
  CORRECTION,
  LATE,
  LATE_CANCEL,
  REASSIGNED,
} from './payroll-lines';
import {
  addDays,
  localDate,
  periodContaining,
  startOfLocalDay,
} from './payroll-time';
import type { PayrollPeriodRow } from './payroll.repository';
import { PayrollService } from './payroll.service';

const CY_ID = '6bcfac7e-8a9d-4ebf-8a3b-4c5d6e7f8a9b';
const INSTRUCTORS = [ADA_ID, BO_ID, CY_ID];
const RATES = [30, 40, 45.5, 50, 80, 33.33];
const MINUTES = [45, 60, 90, 120];
const LESSON_TYPES: (string | null)[] = [
  PRIVATE_90,
  PRIVATE_90,
  GROUP_60,
  null,
];
const TYPE_MINUTES = new Map([
  [PRIVATE_90, 90],
  [GROUP_60, 60],
]);
const HOURS = [0, 10.5, 23.5];
const SEQUENCES = 500;
const ACTOR = { userId: null };
const SETTLEMENT_FLAGS = [LATE, LATE_CANCEL, CORRECTION, REASSIGNED, ADJUSTED];

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (amount: number | string) => Math.round(Number(amount) * 100);
const moneyKey = (classId: string, instructorId: string, currency: string) =>
  `${classId}|${instructorId}|${currency}`;
const rateKey = (
  classId: string,
  instructorId: string,
  lessonTypeId: string | null,
) => `${classId}|${instructorId}|${lessonTypeId}`;

type ModelClass = InMemoryPayrollRepository['classes'][number];
interface ModelRate {
  rate: number | string;
  unit: string;
  currency: string;
}

class Model {
  readonly repo = new InMemoryPayrollRepository();
  readonly service: PayrollService;
  readonly meLessons: MeLessonsService;
  readonly log: string[] = [];
  readonly paidAt = new Map<string, ModelRate | null>();
  readonly problems: string[] = [];
  today = '2026-01-07';

  constructor(private readonly rand: () => number) {
    this.repo.instructorNames.set(CY_ID, {
      display_name_en: 'Cy Wu',
      display_name_zh: null,
      email: 'cy@example.com',
    });
    this.service = new PayrollService(
      this.repo,
      recordingAudit() as unknown as AuditService,
      () => new Date(`${this.today}T17:00:00Z`),
    );
    this.meLessons = new MeLessonsService(
      this.repo,
      {
        onboardingLockFor: () => Promise.resolve(null),
      } as unknown as MeDocumentsService,
      () => new Date(`${this.today}T17:00:00Z`),
    );
    for (const instructorId of INSTRUCTORS) {
      this.repo.addInstructorUser(instructorId, instructorId, 'approved');
    }
    this.repo.addRate({
      instructorId: ADA_ID,
      hourlyRate: 40,
      from: '2020-01-01',
    });
    this.repo.addRate({
      instructorId: BO_ID,
      hourlyRate: 80,
      from: '2020-01-01',
    });
    this.repo.addRate({
      lessonTypeId: GROUP_60,
      hourlyRate: 30,
      from: '2020-01-01',
    });
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)];
  }

  get anchor() {
    return this.repo.settingsRow.anchor_date;
  }

  ownPeriod(startsAt: string): string {
    return periodContaining(this.anchor, localDate(startsAt)).startsOn;
  }

  tableRate(cls: ModelClass): ModelRate | null {
    const date = localDate(cls.starts_at);
    const covering = this.repo.rates.filter(
      (r) =>
        r.lesson_type_id === cls.lesson_type_id &&
        r.effective_from <= date &&
        (r.effective_to === null || date <= r.effective_to),
    );
    const row =
      covering.find((r) => r.instructor_id === cls.instructor_id) ??
      covering.find((r) => r.instructor_id === null);
    return row
      ? { rate: row.hourly_rate, unit: row.rate_unit, currency: row.currency }
      : null;
  }

  owedOf(classId: string): { key: string; cents: number } | null {
    const cls = this.repo.classes.find((c) => c.id === classId);
    if (!cls || cls.status === 'cancelled') return null;
    const paidAt = this.paidAt.get(
      rateKey(classId, cls.instructor_id, cls.lesson_type_id),
    );
    const rate = paidAt === undefined ? this.tableRate(cls) : paidAt;
    const minutes = this.minutesOf(cls);
    const cents = !rate
      ? 0
      : rate.unit === 'day'
        ? Math.round(Number(rate.rate) * 100)
        : Math.round((Math.round(Number(rate.rate) * 100) * minutes) / 60);
    return {
      key: moneyKey(classId, cls.instructor_id, rate?.currency ?? 'CAD'),
      cents,
    };
  }

  syncPaidAt() {
    const paying = this.repo.lineRows.filter(
      (l) => l.kind === 'class' && !l.flags.includes(ALREADY_PAID),
    );
    const keys = new Set(
      paying.map((l) =>
        rateKey(l.class_id as string, l.instructor_id, l.lesson_type_id),
      ),
    );
    for (const key of this.paidAt.keys()) {
      if (!keys.has(key)) this.paidAt.delete(key);
    }
    for (const l of paying) {
      const key = rateKey(
        l.class_id as string,
        l.instructor_id,
        l.lesson_type_id,
      );
      if (this.paidAt.has(key)) continue;
      const cls = this.repo.classes.find((c) => c.id === l.class_id);
      if (
        !cls ||
        cls.instructor_id !== l.instructor_id ||
        cls.lesson_type_id !== l.lesson_type_id
      ) {
        this.problems.push(`first paid ${key} for a lesson it does not match`);
        continue;
      }
      this.paidAt.set(key, this.tableRate(cls));
    }
  }

  async paidLinesShown(): Promise<string[]> {
    const shown: string[] = [];
    for (const period of this.repo.periods.filter((p) => p.status === 'open')) {
      for (const line of (await this.service.detail(period.id)).lines) {
        const cls = this.repo.classes.find((c) => c.id === line.classId);
        if (
          cls &&
          !line.flags.includes(ALREADY_PAID) &&
          this.paidAt.has(
            rateKey(cls.id, cls.instructor_id, cls.lesson_type_id),
          )
        ) {
          shown.push(
            `${period.starts_on} ${moneyKey(line.classId, line.instructorId, line.currency)} ${line.amount}`,
          );
        }
      }
    }
    return shown.sort();
  }

  async editRates(edit: () => void) {
    const before = await this.paidLinesShown();
    edit();
    const after = await this.paidLinesShown();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      this.problems.push(
        `rate edit moved paid lessons: ${before.join(',')} -> ${after.join(',')}`,
      );
    }
  }

  owed(key: string): number {
    const [classId] = key.split('|');
    const owed = this.owedOf(classId);
    return owed && owed.key === key ? owed.cents : 0;
  }

  minutesOf(cls: { starts_at: string; ends_at: string }): number {
    return Math.round(
      (Date.parse(cls.ends_at) - Date.parse(cls.starts_at)) / 60_000,
    );
  }

  finalizedNet(): Map<string, number> {
    const net = new Map<string, number>();
    for (const l of this.repo.lineRows) {
      if (l.kind !== 'class') continue;
      const key = moneyKey(l.class_id as string, l.instructor_id, l.currency);
      net.set(key, (net.get(key) ?? 0) + cents(l.amount));
    }
    return net;
  }

  randomStart(): string {
    const periodStart = addDays(
      periodContaining(this.anchor, this.today).startsOn,
      14 * (Math.floor(this.rand() * 6) - 3),
    );
    const date = addDays(periodStart, Math.floor(this.rand() * 14));
    return new Date(
      Date.parse(startOfLocalDay(date)) + this.pick(HOURS) * 3_600_000,
    ).toISOString();
  }

  async setUp() {
    await this.ensurePeriods();
    for (let i = 0; i < 3; i++) {
      const startsAt = this.randomStart();
      await this.ensurePeriods(localDate(startsAt));
      this.repo.addClass({
        instructorId: this.pick(INSTRUCTORS),
        startsAt,
        minutes: this.pick(MINUTES),
      });
    }
    const today = periodContaining(this.anchor, this.today).startsOn;
    for (const startsOn of [addDays(today, -28), addDays(today, -14)]) {
      const period = this.repo.periods.find((p) => p.starts_on === startsOn);
      if (period) await this.finalize(period);
    }
  }

  async ensurePeriods(date?: string) {
    await this.service.listPeriods(date);
  }

  async currentPeriod(): Promise<PayrollPeriodRow | null> {
    return this.repo.currentPeriod(this.today);
  }

  async step(): Promise<void> {
    const roll = this.rand();
    const active = this.repo.classes.filter((c) => c.status !== 'cancelled');
    const cancelled = this.repo.classes.filter((c) => c.status === 'cancelled');
    const any = this.repo.classes;
    if (roll < 0.14 || any.length === 0) {
      const startsAt = this.randomStart();
      await this.ensurePeriods(localDate(startsAt));
      const cls = this.repo.addClass({
        instructorId: this.pick(INSTRUCTORS),
        lessonTypeId: this.pick(LESSON_TYPES),
        startsAt,
        minutes: this.pick(MINUTES),
      });
      this.log.push(
        `book ${cls.id.slice(-3)} ${cls.instructor_id.slice(0, 2)} ${localDate(startsAt)}`,
      );
    } else if (roll < 0.21 && active.length > 0) {
      const cls = this.pick(active);
      cls.status = 'cancelled';
      this.log.push(`cancel ${cls.id.slice(-3)}`);
    } else if (roll < 0.28 && cancelled.length > 0) {
      const cls = this.pick(cancelled);
      cls.status = 'completed';
      this.log.push(`restore ${cls.id.slice(-3)}`);
    } else if (roll < 0.35) {
      const cls = this.pick(any);
      const minutes = this.minutesOf(cls);
      const startsAt = this.randomStart();
      await this.ensurePeriods(localDate(startsAt));
      cls.starts_at = startsAt;
      cls.ends_at = new Date(
        Date.parse(startsAt) + minutes * 60_000,
      ).toISOString();
      this.log.push(`move ${cls.id.slice(-3)} ${localDate(startsAt)}`);
    } else if (roll < 0.42) {
      const cls = this.pick(any);
      const to = this.pick(INSTRUCTORS.filter((i) => i !== cls.instructor_id));
      cls.instructor_id = to;
      cls.instructor = this.repo.instructorNames.get(to) ?? null;
      this.log.push(`reassign ${cls.id.slice(-3)} ${to.slice(0, 2)}`);
    } else if (roll < 0.49) {
      const cls = this.pick(any);
      const minutes = this.pick(MINUTES);
      cls.ends_at = new Date(
        Date.parse(cls.starts_at) + minutes * 60_000,
      ).toISOString();
      this.log.push(`resize ${cls.id.slice(-3)} ${minutes}`);
    } else if (roll < 0.55) {
      const cls = this.pick(any);
      const lessonTypeId = this.pick(
        LESSON_TYPES.filter((t) => t !== null && t !== cls.lesson_type_id),
      );
      cls.lesson_type_id = lessonTypeId;
      cls.lesson_type = lessonTypeId
        ? (this.repo.lessonTypes.get(lessonTypeId) ?? null)
        : null;
      cls.ends_at = new Date(
        Date.parse(cls.starts_at) +
          (TYPE_MINUTES.get(lessonTypeId ?? '') ?? 90) * 60_000,
      ).toISOString();
      this.log.push(`retype ${cls.id.slice(-3)} ${lessonTypeId?.slice(0, 2)}`);
    } else if (roll < 0.62) {
      await this.editRates(() => this.editRate());
    } else if (roll < 0.66) {
      await this.editRates(() => this.splitRate());
    } else if (roll < 0.8) {
      const current = await this.currentPeriod();
      const after = this.repo.periods.some(
        (p) =>
          p.status === 'open' && current && p.starts_on > current.starts_on,
      );
      if (current && after) {
        await this.finalize(current);
      }
    } else if (roll < 0.9) {
      const finalized = this.repo.periods.filter(
        (p) => p.status === 'finalized',
      );
      if (finalized.length > 0) {
        const period = this.pick(finalized);
        await this.service.reopen(period.id, ACTOR);
        this.syncPaidAt();
        this.log.push(`reopen ${period.starts_on}`);
      }
    } else {
      this.today = addDays(this.today, 14);
      this.log.push(`advance ${this.today}`);
    }
    await this.ensurePeriods();
  }

  editRate() {
    const instructorId = this.rand() < 0.25 ? null : this.pick(INSTRUCTORS);
    const lessonTypeId = this.rand() < 0.7 ? PRIVATE_90 : GROUP_60;
    const hourlyRate = this.pick(RATES);
    const rateUnit = this.rand() < 0.2 ? 'day' : 'hour';
    const currency = this.rand() < 0.1 ? 'USD' : 'CAD';
    const rows = this.repo.rates.filter(
      (r) =>
        r.instructor_id === instructorId && r.lesson_type_id === lessonTypeId,
    );
    if (rows.length > 0) {
      const row = this.pick(rows);
      row.hourly_rate = hourlyRate;
      row.rate_unit = rateUnit;
      row.currency = currency;
    } else {
      this.repo.addRate({
        instructorId,
        lessonTypeId,
        hourlyRate,
        rateUnit,
        currency,
        from: '2020-01-01',
      });
    }
    this.log.push(
      `rate ${instructorId?.slice(0, 2) ?? 'default'} ${lessonTypeId.slice(0, 2)} ${hourlyRate}/${rateUnit} ${currency}`,
    );
  }

  splitRate() {
    if (this.repo.rates.length === 0) return;
    const row = this.pick(this.repo.rates);
    const from = addDays(this.today, Math.floor(this.rand() * 84) - 56);
    if (
      from <= row.effective_from ||
      (row.effective_to !== null && from > row.effective_to)
    ) {
      return;
    }
    const hourlyRate = this.pick(RATES);
    this.repo.addRate({
      instructorId: row.instructor_id,
      lessonTypeId: row.lesson_type_id,
      hourlyRate,
      rateUnit: row.rate_unit,
      currency: row.currency,
      from,
      to: row.effective_to,
    });
    row.effective_to = addDays(from, -1);
    this.log.push(
      `split ${row.instructor_id?.slice(0, 2) ?? 'default'} ${row.lesson_type_id.slice(0, 2)} ${from} ${hourlyRate}`,
    );
  }

  async finalize(period: PayrollPeriodRow) {
    await this.service.finalize(period.id, { acceptZeroRate: true }, ACTOR);
    this.syncPaidAt();
    this.log.push(`finalize ${period.starts_on}`);
  }

  async check(): Promise<string[]> {
    const problems: string[] = this.problems.splice(0);
    const current = await this.currentPeriod();
    const shown = new Map<string, number>();
    for (const period of this.repo.periods.filter((p) => p.status === 'open')) {
      const { lines } = await this.service.detail(period.id);
      const seen = new Set<string>();
      for (const line of lines) {
        const key = moneyKey(line.classId, line.instructorId, line.currency);
        if (seen.has(key))
          problems.push(`duplicate ${key} in ${period.starts_on}`);
        seen.add(key);
        shown.set(key, (shown.get(key) ?? 0) + cents(line.amount));
        const cls = this.repo.classes.find((c) => c.id === line.classId);
        const settlement = line.flags.some((f) => SETTLEMENT_FLAGS.includes(f));
        if (settlement && period.id !== current?.id) {
          problems.push(
            `settlement line ${key} ${line.flags.join(',')} in non-current ${period.starts_on}`,
          );
        }
        if (line.flags.includes(ALREADY_PAID) && cents(line.amount) !== 0) {
          problems.push(`already paid ${key} with an amount`);
        }
        if (
          !settlement &&
          !line.flags.includes(ALREADY_PAID) &&
          (this.ownPeriod(line.startsAt) !== period.starts_on ||
            cls?.instructor_id !== line.instructorId)
        ) {
          problems.push(
            `normal line ${key} outside its own period ${period.starts_on}`,
          );
        }
        const sign = Math.sign(cents(line.amount));
        if (line.flags.includes(ADJUSTED)) {
          if (
            cls?.status === 'cancelled' ||
            cls?.instructor_id !== line.instructorId
          ) {
            problems.push(`adjusted ${key} on a lesson it no longer holds`);
          }
          if (
            [LATE, LATE_CANCEL, CORRECTION, REASSIGNED].some((f) =>
              line.flags.includes(f),
            )
          ) {
            problems.push(`adjusted ${key} with ${line.flags.join(',')}`);
          }
          if (!this.paidBefore(line.classId, line.instructorId)) {
            problems.push(`adjusted ${key} that was never paid`);
          }
        }
        if (line.flags.includes(LATE_CANCEL) && line.flags.includes(LATE)) {
          problems.push(`both labels on ${key}`);
        }
        if (line.flags.includes(LATE_CANCEL) && sign !== 0) {
          const runsBack = sign > 0;
          if (runsBack !== line.flags.includes(CORRECTION)) {
            problems.push(
              `late cancel ${key} ${line.amount} correction mismatch`,
            );
          }
        }
        if (line.flags.includes(LATE) && sign !== 0) {
          const runsBack = sign < 0;
          if (runsBack !== line.flags.includes(CORRECTION)) {
            problems.push(`late ${key} ${line.amount} correction mismatch`);
          }
        }
      }
    }
    problems.push(...this.compare(shown, () => true, ''));
    problems.push(...(await this.checkInstructorView()));
    return problems;
  }

  async checkInstructorView(): Promise<string[]> {
    const problems: string[] = [];
    for (const instructorId of INSTRUCTORS) {
      const view = await this.meLessons.lessons(instructorId);
      const places = new Map<string, string[]>();
      const shown = new Map<string, number>();
      const add = (key: string, place: string, amount: number | null) => {
        places.set(key, [...(places.get(key) ?? []), place]);
        shown.set(key, (shown.get(key) ?? 0) + cents(amount ?? 0));
      };
      for (const lesson of view.upcoming.lessons) {
        add(
          moneyKey(lesson.classId, instructorId, lesson.currency),
          'upcoming',
          lesson.amount,
        );
      }
      const projectedCents = view.upcoming.projected.reduce(
        (sum, total) => sum + cents(total.amount),
        0,
      );
      const upcomingCents = view.upcoming.lessons.reduce(
        (sum, lesson) => sum + cents(lesson.amount ?? 0),
        0,
      );
      if (projectedCents !== upcomingCents) {
        problems.push(
          `${instructorId.slice(0, 2)} projected ${projectedCents} != upcoming lessons ${upcomingCents}`,
        );
      }
      for (const period of view.periods) {
        if (period.status !== 'awaiting') continue;
        for (const lesson of period.lessons) {
          add(
            moneyKey(lesson.classId, instructorId, lesson.currency),
            period.startsOn,
            lesson.amount,
          );
        }
      }
      for (const [key, where] of places) {
        if (where.length > 1) {
          problems.push(`instructor view ${key} in ${where.join(' and ')}`);
        }
      }
      problems.push(
        ...this.compare(
          shown,
          (key) => key.split('|')[1] === instructorId,
          'instructor view ',
        ),
      );
    }
    return problems;
  }

  paidBefore(classId: string, instructorId: string): boolean {
    return this.repo.lineRows.some(
      (l) =>
        l.kind === 'class' &&
        l.class_id === classId &&
        l.instructor_id === instructorId &&
        !l.flags.includes(ALREADY_PAID),
    );
  }

  compare(
    shown: Map<string, number>,
    include: (key: string) => boolean,
    label: string,
  ): string[] {
    const net = this.finalizedNet();
    const keys = new Set([...net.keys(), ...shown.keys()]);
    for (const cls of this.repo.classes) {
      const owed = this.owedOf(cls.id);
      if (owed) keys.add(owed.key);
    }
    const problems: string[] = [];
    for (const key of [...keys].filter(include)) {
      const owed = this.owed(key);
      const total = (net.get(key) ?? 0) + (shown.get(key) ?? 0);
      if (total !== owed) {
        problems.push(
          `${label}${key}: finalized ${net.get(key) ?? 0} + shown ${shown.get(key) ?? 0} != owed ${owed}`,
        );
      }
    }
    return problems;
  }

  async finalizeEverything(): Promise<void> {
    for (;;) {
      const open = this.repo.periods
        .filter((p) => p.status === 'open')
        .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
      if (open.length === 0) return;
      await this.finalize(open[0]);
    }
  }
}

async function run(seed: number): Promise<string | null> {
  const rand = random(seed);
  const model = new Model(rand);
  await model.setUp();
  const steps = 5 + Math.floor(rand() * 11);
  for (let i = 0; i < steps; i++) {
    await model.step();
    const problems = await model.check();
    if (problems.length > 0) {
      return `seed ${seed} after [${model.log.join('; ')}]: ${problems.join(', ')}`;
    }
  }
  await model.finalizeEverything();
  const problems = [
    ...(await model.check()),
    ...model.compare(new Map(), () => true, 'after finalizing everything '),
  ];
  return problems.length > 0
    ? `seed ${seed} after [${model.log.join('; ')}; finalize all]: ${problems.join(', ')}`
    : null;
}

describe('payroll settlement invariant', () => {
  it(`holds in the admin and instructor views for ${SEQUENCES} random sequences of bookings, edits, length and lesson type changes, rate edits that leave paid lessons alone, finalizes, reopens and days passing`, async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const failure = await run(seed);
      if (failure) failures.push(failure);
    }
    expect(failures.slice(0, 5)).toEqual([]);
    expect(failures).toHaveLength(0);
  });

  describe('scripted', () => {
    let model: Model;
    const periodOn = (startsOn: string) => {
      const period = model.repo.periods.find((p) => p.starts_on === startsOn);
      if (!period) throw new Error(`no period ${startsOn}`);
      return period;
    };
    const retype = (cls: ModelClass, lessonTypeId: string) => {
      cls.lesson_type_id = lessonTypeId;
      cls.lesson_type = model.repo.lessonTypes.get(lessonTypeId) ?? null;
      cls.ends_at = new Date(
        Date.parse(cls.starts_at) +
          (TYPE_MINUTES.get(lessonTypeId) ?? 90) * 60_000,
      ).toISOString();
    };
    const net = (cls: ModelClass) =>
      [...model.finalizedNet()]
        .filter(([key]) => key.startsWith(`${cls.id}|`))
        .map(([key, cents]) => [key.split('|').slice(1).join('|'), cents]);
    const editEveryRate = (hourlyRate: number) =>
      model.editRates(() => {
        for (const row of model.repo.rates) {
          row.hourly_rate = hourlyRate;
          row.rate_unit = 'day';
        }
        model.repo.addRate({
          instructorId: ADA_ID,
          lessonTypeId: GROUP_60,
          hourlyRate: hourlyRate + 1,
          from: '2025-12-01',
          to: '2025-12-31',
        });
      });

    beforeEach(async () => {
      model = new Model(() => 0);
      await model.ensurePeriods();
    });

    it('never moves a paid lesson when any rate is edited', async () => {
      const cls = model.repo.addClass({
        instructorId: ADA_ID,
        startsAt: '2025-12-20T15:00:00Z',
      });
      await model.finalize(periodOn('2025-12-15'));
      await editEveryRate(99);
      expect(await model.check()).toEqual([]);
      expect(
        (await model.service.detail(periodOn('2025-12-29').id)).lines,
      ).toEqual([]);
      expect(net(cls)).toEqual([[`${ADA_ID}|CAD`, 6000]]);
    });

    it('returns to the first type’s original terms after A → B → A are all finalized, whatever either rate does later', async () => {
      const cls = model.repo.addClass({
        instructorId: ADA_ID,
        startsAt: '2025-12-20T15:00:00Z',
      });
      await model.finalize(periodOn('2025-12-15'));
      expect(net(cls)).toEqual([[`${ADA_ID}|CAD`, 6000]]);
      retype(cls, GROUP_60);
      expect(await model.check()).toEqual([]);
      await model.finalize(periodOn('2025-12-29'));
      expect(net(cls)).toEqual([[`${ADA_ID}|CAD`, 3000]]);
      retype(cls, PRIVATE_90);
      expect(await model.check()).toEqual([]);
      await model.finalize(periodOn('2026-01-12'));
      expect(net(cls)).toEqual([[`${ADA_ID}|CAD`, 6000]]);
      await editEveryRate(99);
      expect(await model.check()).toEqual([]);
      expect(
        (await model.service.detail(periodOn('2026-01-26').id)).lines,
      ).toEqual([]);
      retype(cls, GROUP_60);
      expect(
        (await model.service.detail(periodOn('2026-01-26').id)).lines.map(
          (l) => [l.amount, l.hourlyRate, l.flags],
        ),
      ).toEqual([
        [-30, 30, ['adjusted', 'changed_length', 'changed_lesson_type']],
      ]);
      expect(await model.check()).toEqual([]);
    });

    it('tags a reversal with the lesson type it takes back, so a later return is priced at the new type', async () => {
      const cls = model.repo.addClass({
        instructorId: ADA_ID,
        startsAt: '2025-12-20T15:00:00Z',
      });
      await model.finalize(periodOn('2025-12-15'));
      retype(cls, GROUP_60);
      cls.instructor_id = BO_ID;
      await model.finalize(periodOn('2025-12-29'));
      const reversal = model.repo.lineRows.find(
        (l) => l.instructor_id === ADA_ID && l.flags.includes(LATE_CANCEL),
      );
      expect(reversal?.lesson_type_id).toBe(PRIVATE_90);
      cls.instructor_id = ADA_ID;
      expect(
        (await model.service.detail(periodOn('2026-01-12').id)).lines.map(
          (l) => [l.instructorId, l.amount],
        ),
      ).toEqual([
        [ADA_ID, 30],
        [BO_ID, -30],
      ]);
      expect(await model.check()).toEqual([]);
    });

    it('lets a lesson type change that is not finalized yet follow the new type’s current rate', async () => {
      const cls = model.repo.addClass({
        instructorId: ADA_ID,
        startsAt: '2025-12-20T15:00:00Z',
      });
      await model.finalize(periodOn('2025-12-15'));
      retype(cls, GROUP_60);
      const amounts = async () =>
        (await model.service.detail(periodOn('2025-12-29').id)).lines.map(
          (l) => l.amount,
        );
      expect(await amounts()).toEqual([-30]);
      model.repo.rates.find((r) => r.lesson_type_id === GROUP_60)!.hourly_rate =
        45;
      expect(await amounts()).toEqual([-15]);
      expect(await model.check()).toEqual([]);
    });
  });
});
