import {
  ADA_ID,
  BO_ID,
  InMemoryPayrollRepository,
} from '../../test/helpers/payroll-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import type { AuditService } from '../audit/audit.service';
import {
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
const MINUTES = [45, 60, 90];
const HOURS = [0, 10.5, 23.5];
const SEQUENCES = 500;
const ACTOR = { userId: null };
const SETTLEMENT_FLAGS = [LATE, LATE_CANCEL, CORRECTION, REASSIGNED];

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
const pairKey = (classId: string, instructorId: string) =>
  `${classId}|${instructorId}`;

class Model {
  readonly repo = new InMemoryPayrollRepository();
  readonly service: PayrollService;
  readonly terms = new Map<string, number>();
  readonly log: string[] = [];
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

  rateCents(instructorId: string, minutes: number): number {
    const row = this.repo.rates.find((r) => r.instructor_id === instructorId);
    if (!row) return 0;
    return row.rate_unit === 'day'
      ? cents(row.hourly_rate)
      : Math.round((cents(row.hourly_rate) * minutes) / 60);
  }

  minutesOf(cls: { starts_at: string; ends_at: string }): number {
    return Math.round(
      (Date.parse(cls.ends_at) - Date.parse(cls.starts_at)) / 60_000,
    );
  }

  owed(classId: string, instructorId: string): number {
    const cls = this.repo.classes.find((c) => c.id === classId);
    if (
      !cls ||
      cls.status === 'cancelled' ||
      cls.instructor_id !== instructorId
    ) {
      return 0;
    }
    return (
      this.terms.get(pairKey(classId, instructorId)) ??
      this.rateCents(instructorId, this.minutesOf(cls))
    );
  }

  paidPairs(): Set<string> {
    return new Set(
      this.repo.lineRows
        .filter((l) => l.kind === 'class' && !l.flags.includes(ALREADY_PAID))
        .map((l) => pairKey(l.class_id as string, l.instructor_id)),
    );
  }

  finalizedNet(): Map<string, number> {
    const net = new Map<string, number>();
    for (const l of this.repo.lineRows) {
      if (l.kind !== 'class') continue;
      const key = pairKey(l.class_id as string, l.instructor_id);
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
    if (roll < 0.18 || any.length === 0) {
      const startsAt = this.randomStart();
      await this.ensurePeriods(localDate(startsAt));
      const cls = this.repo.addClass({
        instructorId: this.pick(INSTRUCTORS),
        startsAt,
        minutes: this.pick(MINUTES),
      });
      this.log.push(
        `book ${cls.id.slice(-3)} ${cls.instructor_id.slice(0, 2)} ${localDate(startsAt)}`,
      );
    } else if (roll < 0.28 && active.length > 0) {
      const cls = this.pick(active);
      cls.status = 'cancelled';
      this.log.push(`cancel ${cls.id.slice(-3)}`);
    } else if (roll < 0.38 && cancelled.length > 0) {
      const cls = this.pick(cancelled);
      cls.status = 'completed';
      this.log.push(`restore ${cls.id.slice(-3)}`);
    } else if (roll < 0.48) {
      const cls = this.pick(any);
      const minutes = this.minutesOf(cls);
      const startsAt = this.randomStart();
      await this.ensurePeriods(localDate(startsAt));
      cls.starts_at = startsAt;
      cls.ends_at = new Date(
        Date.parse(startsAt) + minutes * 60_000,
      ).toISOString();
      this.log.push(`move ${cls.id.slice(-3)} ${localDate(startsAt)}`);
    } else if (roll < 0.58) {
      const cls = this.pick(any);
      const to = this.pick(INSTRUCTORS.filter((i) => i !== cls.instructor_id));
      cls.instructor_id = to;
      cls.instructor = this.repo.instructorNames.get(to) ?? null;
      this.log.push(`reassign ${cls.id.slice(-3)} ${to.slice(0, 2)}`);
    } else if (roll < 0.65) {
      const instructorId = this.pick(INSTRUCTORS);
      const hourlyRate = this.pick(RATES);
      const rateUnit = this.rand() < 0.2 ? 'day' : 'hour';
      const row = this.repo.rates.find((r) => r.instructor_id === instructorId);
      if (row) {
        row.hourly_rate = hourlyRate;
        row.rate_unit = rateUnit;
      } else {
        this.repo.addRate({
          instructorId,
          hourlyRate,
          rateUnit,
          from: '2020-01-01',
        });
      }
      this.log.push(
        `rate ${instructorId.slice(0, 2)} ${hourlyRate}/${rateUnit}`,
      );
    } else if (roll < 0.82) {
      const current = await this.currentPeriod();
      const after = this.repo.periods.some(
        (p) =>
          p.status === 'open' && current && p.starts_on > current.starts_on,
      );
      if (current && after) {
        await this.finalize(current);
      }
    } else if (roll < 0.92) {
      const finalized = this.repo.periods.filter(
        (p) => p.status === 'finalized',
      );
      if (finalized.length > 0) {
        const period = this.pick(finalized);
        const before = this.paidPairs();
        await this.service.reopen(period.id, ACTOR);
        const after = this.paidPairs();
        for (const key of before) {
          if (!after.has(key)) this.terms.delete(key);
        }
        this.log.push(`reopen ${period.starts_on}`);
      }
    } else {
      this.today = addDays(this.today, 14);
      this.log.push(`advance ${this.today}`);
    }
    await this.ensurePeriods();
  }

  async finalize(period: PayrollPeriodRow) {
    const before = this.paidPairs();
    await this.service.finalize(period.id, { acceptZeroRate: true }, ACTOR);
    for (const key of this.paidPairs()) {
      if (before.has(key)) continue;
      const [classId, instructorId] = key.split('|');
      const cls = this.repo.classes.find((c) => c.id === classId);
      if (!cls) continue;
      this.terms.set(key, this.rateCents(instructorId, this.minutesOf(cls)));
    }
    this.log.push(`finalize ${period.starts_on}`);
  }

  async check(): Promise<string[]> {
    const problems: string[] = [];
    const current = await this.currentPeriod();
    const shown = new Map<string, number>();
    for (const period of this.repo.periods.filter((p) => p.status === 'open')) {
      const { lines } = await this.service.detail(period.id);
      const seen = new Set<string>();
      for (const line of lines) {
        const key = pairKey(line.classId, line.instructorId);
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
    const net = this.finalizedNet();
    const keys = new Set([...net.keys(), ...shown.keys()]);
    for (const cls of this.repo.classes)
      keys.add(pairKey(cls.id, cls.instructor_id));
    for (const key of keys) {
      const [classId, instructorId] = key.split('|');
      const owed = this.owed(classId, instructorId);
      const total = (net.get(key) ?? 0) + (shown.get(key) ?? 0);
      if (total !== owed) {
        problems.push(
          `${classId.slice(-3)}|${instructorId.slice(0, 2)}: finalized ${net.get(key) ?? 0} + shown ${shown.get(key) ?? 0} != owed ${owed}`,
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
  const problems = await model.check();
  const net = model.finalizedNet();
  for (const cls of model.repo.classes) {
    for (const instructorId of INSTRUCTORS) {
      const key = pairKey(cls.id, instructorId);
      if ((net.get(key) ?? 0) !== model.owed(cls.id, instructorId)) {
        problems.push(
          `${key} finalized ${net.get(key) ?? 0} != owed ${model.owed(cls.id, instructorId)}`,
        );
      }
    }
  }
  return problems.length > 0
    ? `seed ${seed} after [${model.log.join('; ')}; finalize all]: ${problems.join(', ')}`
    : null;
}

describe('payroll settlement invariant', () => {
  it(`holds for ${SEQUENCES} random sequences of bookings, edits, rate changes, finalizes, reopens and days passing`, async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const failure = await run(seed);
      if (failure) failures.push(failure);
    }
    expect(failures.slice(0, 5)).toEqual([]);
    expect(failures).toHaveLength(0);
  });
});
