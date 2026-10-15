import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import {
  DatabaseError,
  PG_CHECK_VIOLATION,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
} from '../database/db-result';
import type { CreatePayRateDto, UpdatePayRateDto } from './dto/pay-rate.dto';
import { type RateUnit, resolveRate } from './pay-rates';
import {
  type PayRateFilter,
  type PayRatePatch,
  type PayRateRow,
  PayRatesRepository,
} from './pay-rates.repository';

export const PAY_RATE_NOT_FOUND = 'Pay rate not found';
export const PAY_RATE_OVERLAP =
  'This rate overlaps another rate for the same lesson type and instructor';
export const PAY_RATE_RANGE_INVALID =
  'effectiveTo must be on or after effectiveFrom';
export const PAY_RATE_LESSON_TYPE_NOT_FOUND = 'Lesson type not found';
export const PAY_RATE_INSTRUCTOR_NOT_FOUND = 'Instructor not found';
export const NOTHING_TO_UPDATE = 'Nothing to update';

export interface PayRate {
  id: string;
  lessonTypeId: string;
  instructorId: string | null;
  hourlyRate: number;
  rateUnit: RateUnit;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedPayRate {
  source: 'instructor' | 'default' | null;
  rate: PayRate | null;
}

export function toPayRate(row: PayRateRow): PayRate {
  return {
    id: row.id,
    lessonTypeId: row.lesson_type_id,
    instructorId: row.instructor_id,
    hourlyRate: Number(row.hourly_rate),
    rateUnit: row.rate_unit,
    currency: row.currency,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertRange(from: string, to: string | null): void {
  if (to !== null && to < from) {
    throw new BadRequestException(PAY_RATE_RANGE_INVALID);
  }
}

function toHttp(err: unknown): unknown {
  if (!(err instanceof DatabaseError)) {
    return err;
  }
  switch (err.code) {
    case PG_EXCLUSION_VIOLATION:
      return new ConflictException(PAY_RATE_OVERLAP);
    case PG_CHECK_VIOLATION:
      return new BadRequestException(PAY_RATE_RANGE_INVALID);
    case PG_FOREIGN_KEY_VIOLATION:
      return new BadRequestException(
        err.message.includes('lesson_type_id')
          ? PAY_RATE_LESSON_TYPE_NOT_FOUND
          : PAY_RATE_INSTRUCTOR_NOT_FOUND,
      );
    default:
      return err;
  }
}

@Injectable()
export class PayRatesService {
  constructor(
    private readonly repo: PayRatesRepository,
    private readonly audit: AuditService,
  ) {}

  async list(filter: PayRateFilter): Promise<PayRate[]> {
    return (await this.repo.list(filter)).map(toPayRate);
  }

  async resolve(
    instructorId: string,
    lessonTypeId: string,
    date: string,
  ): Promise<ResolvedPayRate> {
    const rates = (await this.repo.ratesFor(lessonTypeId, instructorId)).map(
      toPayRate,
    );
    const rate = resolveRate(rates, instructorId, lessonTypeId, date);
    return {
      source: rate ? (rate.instructorId ? 'instructor' : 'default') : null,
      rate,
    };
  }

  async create(dto: CreatePayRateDto, actor: AuditActor): Promise<PayRate> {
    const effectiveTo = dto.effectiveTo ?? null;
    assertRange(dto.effectiveFrom, effectiveTo);
    let row: PayRateRow;
    try {
      row = await this.repo.insert({
        lesson_type_id: dto.lessonTypeId,
        instructor_id: dto.instructorId ?? null,
        hourly_rate: dto.hourlyRate,
        ...(dto.rateUnit ? { rate_unit: dto.rateUnit } : {}),
        ...(dto.currency ? { currency: dto.currency } : {}),
        effective_from: dto.effectiveFrom,
        effective_to: effectiveTo,
        created_by: actor.userId ?? null,
      });
    } catch (err) {
      throw toHttp(err);
    }
    const rate = toPayRate(row);
    await this.audit.record({
      action: AUDIT_ACTIONS.payRateCreate,
      actor: { ...actor, role: 'admin' },
      targetType: 'pay_rate',
      targetId: rate.id,
      metadata: { after: rate },
    });
    return rate;
  }

  async update(
    id: string,
    dto: UpdatePayRateDto,
    actor: AuditActor,
  ): Promise<PayRate> {
    const patch: PayRatePatch = {};
    if (dto.hourlyRate !== undefined) patch.hourly_rate = dto.hourlyRate;
    if (dto.rateUnit !== undefined) patch.rate_unit = dto.rateUnit;
    if (dto.currency !== undefined) patch.currency = dto.currency;
    if (dto.effectiveFrom !== undefined)
      patch.effective_from = dto.effectiveFrom;
    if (dto.effectiveTo !== undefined) patch.effective_to = dto.effectiveTo;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException(NOTHING_TO_UPDATE);
    }
    const beforeRow = await this.repo.findById(id);
    if (!beforeRow) {
      throw new NotFoundException(PAY_RATE_NOT_FOUND);
    }
    const before = toPayRate(beforeRow);
    assertRange(
      patch.effective_from ?? before.effectiveFrom,
      patch.effective_to === undefined
        ? before.effectiveTo
        : patch.effective_to,
    );
    let row: PayRateRow | null;
    try {
      row = await this.repo.update(id, patch);
    } catch (err) {
      throw toHttp(err);
    }
    if (!row) {
      throw new NotFoundException(PAY_RATE_NOT_FOUND);
    }
    const after = toPayRate(row);
    await this.audit.record({
      action: AUDIT_ACTIONS.payRateUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'pay_rate',
      targetId: id,
      metadata: { before, after },
    });
    return after;
  }
}
