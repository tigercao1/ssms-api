import { createHash } from 'node:crypto';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { AuditActor } from '../audit/audit.types';
import {
  GOOGLE_NOT_CONFIGURED,
  GOOGLE_NOT_CONNECTED,
  GOOGLE_UNAVAILABLE,
} from '../google/google-error.filter';
import {
  GoogleError,
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
} from '../google/google.errors';
import { type BatchRowRecord, BookingRepository } from './booking.repository';
import {
  BookingService,
  CALENDAR_UNAVAILABLE,
  CUSTOMER_NOT_FOUND,
  FUTURE_STATUS,
  GOOGLE_WRITE_FAILED,
  INSTRUCTOR_BUSY,
  INSTRUCTOR_NOT_BOOKABLE,
  INSTRUCTOR_NOT_FOUND,
  LESSON_TYPE_INACTIVE,
  LESSON_TYPE_NOT_FOUND,
  LOCATION_NOT_FOUND,
  REFERENCE_NOT_FOUND,
} from './booking.service';
import { type BookedClass, toBookedClass } from './calendar-sync.service';
import type { BatchBookingDto, BookingRowDto } from './dto/booking.dto';

export const BATCH_ROW_CONFLICT = 'BATCH_ROW_CONFLICT';
export const BATCH_ROW_CONFLICT_MESSAGE =
  'This batch row was already booked with different details';
export const BOOKING_FAILED = 'BOOKING_FAILED';
export const INTERNAL_ERROR = 'INTERNAL_ERROR';
export const INTERNAL_ERROR_MESSAGE = 'The booking could not be saved';

const CODES: Record<string, string> = {
  [INSTRUCTOR_NOT_FOUND]: 'INSTRUCTOR_NOT_FOUND',
  [INSTRUCTOR_NOT_BOOKABLE]: 'INSTRUCTOR_NOT_BOOKABLE',
  [LESSON_TYPE_NOT_FOUND]: 'LESSON_TYPE_NOT_FOUND',
  [LESSON_TYPE_INACTIVE]: 'LESSON_TYPE_INACTIVE',
  [CUSTOMER_NOT_FOUND]: 'CUSTOMER_NOT_FOUND',
  [LOCATION_NOT_FOUND]: 'LOCATION_NOT_FOUND',
  [INSTRUCTOR_BUSY]: 'INSTRUCTOR_BUSY',
  [CALENDAR_UNAVAILABLE]: 'CALENDAR_UNAVAILABLE',
  [FUTURE_STATUS]: 'FUTURE_STATUS',
  [REFERENCE_NOT_FOUND]: 'REFERENCE_NOT_FOUND',
  [GOOGLE_WRITE_FAILED]: 'GOOGLE_WRITE_FAILED',
};

export interface BatchRowCreated {
  index: number;
  status: 'created';
  classes: BookedClass[];
}

export interface BatchRowFailed {
  index: number;
  status: 'failed';
  code: string;
  message: string;
}

export type BatchRowResult = BatchRowCreated | BatchRowFailed;

export interface BatchBookingResult {
  batchId: string;
  results: BatchRowResult[];
}

@Injectable()
export class BookingBatchService {
  private readonly logger = new Logger(BookingBatchService.name);

  constructor(
    private readonly booking: BookingService,
    private readonly repo: BookingRepository,
  ) {}

  async create(
    dto: BatchBookingDto,
    actor: AuditActor,
  ): Promise<BatchBookingResult> {
    const recorded = await this.recordedRows(dto.batchId);
    const results: BatchRowResult[] = [];
    for (const [index, row] of dto.bookings.entries()) {
      results.push(
        await this.createRow(
          dto.batchId,
          index,
          row,
          recorded.get(index),
          actor,
        ),
      );
    }
    return { batchId: dto.batchId, results };
  }

  private async createRow(
    batchId: string,
    index: number,
    row: BookingRowDto,
    recorded: BatchRowRecord | undefined,
    actor: AuditActor,
  ): Promise<BatchRowResult> {
    const payloadHash = rowHash(row);
    if (recorded) {
      return this.replay(index, recorded, payloadHash);
    }
    try {
      const outcome = await this.booking.createBatchRow(row, actor, {
        batch_id: batchId,
        row_index: index,
        payload_hash: payloadHash,
      });
      return 'created' in outcome
        ? { index, status: 'created', classes: outcome.created }
        : await this.replay(index, outcome.existing, payloadHash);
    } catch (err) {
      const late = (await this.recordedRows(batchId)).get(index);
      if (late) {
        return this.replay(index, late, payloadHash);
      }
      return this.failed(index, err);
    }
  }

  private async replay(
    index: number,
    recorded: BatchRowRecord,
    payloadHash: string,
  ): Promise<BatchRowResult> {
    if (recorded.payload_hash !== payloadHash) {
      return {
        index,
        status: 'failed',
        code: BATCH_ROW_CONFLICT,
        message: BATCH_ROW_CONFLICT_MESSAGE,
      };
    }
    const classes = await this.repo.findClasses([recorded.class_id]);
    return { index, status: 'created', classes: classes.map(toBookedClass) };
  }

  private failed(index: number, err: unknown): BatchRowFailed {
    if (err instanceof HttpException) {
      const message = httpMessage(err);
      return {
        index,
        status: 'failed',
        code: CODES[message] ?? BOOKING_FAILED,
        message,
      };
    }
    if (err instanceof GoogleNotConnectedError) {
      return {
        index,
        status: 'failed',
        code: 'GOOGLE_NOT_CONNECTED',
        message: GOOGLE_NOT_CONNECTED,
      };
    }
    if (err instanceof GoogleNotConfiguredError) {
      return {
        index,
        status: 'failed',
        code: 'GOOGLE_NOT_CONFIGURED',
        message: GOOGLE_NOT_CONFIGURED,
      };
    }
    if (err instanceof GoogleError) {
      this.logger.error(err.message);
      return {
        index,
        status: 'failed',
        code: CODES[GOOGLE_WRITE_FAILED],
        message: GOOGLE_UNAVAILABLE,
      };
    }
    this.logger.error(
      `Batch booking row ${index} failed`,
      err instanceof Error ? err.stack : String(err),
    );
    return {
      index,
      status: 'failed',
      code: INTERNAL_ERROR,
      message: INTERNAL_ERROR_MESSAGE,
    };
  }

  private async recordedRows(
    batchId: string,
  ): Promise<Map<number, BatchRowRecord>> {
    const rows = await this.repo.findBatchRows(batchId);
    return new Map(rows.map((r) => [r.row_index, r]));
  }
}

export function rowHash(row: BookingRowDto): string {
  const canonical = [
    row.instructorId,
    row.lessonTypeId,
    new Date(row.startsAt).toISOString(),
    [...row.customerIds].sort(),
    row.locationId ?? null,
    row.notes?.trim() || null,
    row.status ?? null,
    row.addToCalendar ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function httpMessage(err: HttpException): string {
  const body = err.getResponse();
  if (typeof body === 'string') {
    return body;
  }
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) {
    return message.join('; ');
  }
  return typeof message === 'string' ? message : err.message;
}
