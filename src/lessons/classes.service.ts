import {
  BadRequestException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { localParts } from '../booking/booking-time';
import { pageOffset } from '../database/pagination';
import { classesCsv } from './classes-csv';
import {
  type ClassFilter,
  ClassesRepository,
  type ClassRow,
  MAX_CLASSES_PER_LIST,
} from './classes.repository';
import { CLASS_LIST_DEFAULT_LIMIT } from './dto/list-classes-query.dto';
import type {
  Attendance,
  ClassSort,
  ClassSource,
  ClassStatus,
  GoogleSyncStatus,
} from './lessons.types';

export const CLASS_RANGE_INVALID = '`to` must be after `from`';
export const CLASS_CREATED_RANGE_INVALID =
  '`createdTo` must be after `createdFrom`';
export const CLASS_EXPORT_MAX_ROWS = 10_000;
export const CLASS_EXPORT_TOO_LARGE = `Export is limited to ${CLASS_EXPORT_MAX_ROWS} classes; narrow the filters`;

export interface AdminClassParticipant {
  customerId: string;
  attendance: Attendance;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
}

export interface AdminClass {
  id: string;
  instructorId: string;
  instructorName: string | null;
  instructorNameZh: string | null;
  lessonTypeId: string | null;
  lessonTypeNameEn: string | null;
  lessonTypeNameZh: string | null;
  durationMin: number | null;
  groupSize: number | null;
  isPromo: boolean | null;
  locationId: string | null;
  locationName: string | null;
  startsAt: string;
  endsAt: string;
  status: ClassStatus;
  source: ClassSource;
  googleCalendarId: string | null;
  googleEventId: string | null;
  googleSyncStatus: GoogleSyncStatus;
  googleSyncError: string | null;
  googleSyncAttempts: number;
  googleSyncedAt: string | null;
  notes: string | null;
  participants: AdminClassParticipant[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminClassPage {
  classes: AdminClass[];
  total: number;
}

export interface ClassesExportFile {
  filename: string;
  body: string;
}

function isAfter(later: string | undefined, earlier: string | undefined) {
  return !later || !earlier || Date.parse(later) > Date.parse(earlier);
}

function assertRanges(filter: ClassFilter): void {
  if (!isAfter(filter.to, filter.from)) {
    throw new BadRequestException(CLASS_RANGE_INVALID);
  }
  if (!isAfter(filter.createdTo, filter.createdFrom)) {
    throw new BadRequestException(CLASS_CREATED_RANGE_INVALID);
  }
}

@Injectable()
export class ClassesService {
  constructor(private readonly repo: ClassesRepository) {}

  async list(
    filter: ClassFilter,
    page?: number,
    limit?: number,
    sort?: ClassSort,
  ): Promise<AdminClassPage> {
    assertRanges(filter);
    const size = limit ?? CLASS_LIST_DEFAULT_LIMIT;
    const { rows, total } = await this.repo.list(
      filter,
      page === undefined && limit === undefined
        ? undefined
        : { limit: size, offset: pageOffset(page ?? 1, size) },
      sort,
    );
    return { classes: rows.map(toAdminClass), total };
  }

  async export(
    filter: ClassFilter,
    sort?: ClassSort,
    now = new Date(),
  ): Promise<ClassesExportFile> {
    assertRanges(filter);
    const first = await this.repo.list(
      filter,
      { limit: MAX_CLASSES_PER_LIST, offset: 0 },
      sort,
    );
    if (first.total > CLASS_EXPORT_MAX_ROWS) {
      throw new UnprocessableEntityException(CLASS_EXPORT_TOO_LARGE);
    }
    const rows = [...first.rows];
    while (rows.length < first.total) {
      const next = await this.repo.list(
        filter,
        { limit: MAX_CLASSES_PER_LIST, offset: rows.length },
        sort,
      );
      if (next.rows.length === 0) {
        break;
      }
      rows.push(...next.rows);
    }
    return {
      filename: `classes-${localParts(now).date}.csv`,
      body: classesCsv(rows.map(toAdminClass)),
    };
  }
}

export function toAdminClass(row: ClassRow): AdminClass {
  return {
    id: row.id,
    instructorId: row.instructor_id,
    instructorName: row.instructor?.display_name_en ?? null,
    instructorNameZh: row.instructor?.display_name_zh ?? null,
    lessonTypeId: row.lesson_type_id,
    lessonTypeNameEn: row.lesson_type?.name_en ?? null,
    lessonTypeNameZh: row.lesson_type?.name_zh ?? null,
    durationMin: row.lesson_type?.duration_min ?? null,
    groupSize: row.lesson_type?.group_size ?? null,
    isPromo: row.lesson_type?.is_promo ?? null,
    locationId: row.location_id,
    locationName: row.location?.name ?? null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    source: row.source,
    googleCalendarId: row.google_calendar_id,
    googleEventId: row.google_event_id,
    googleSyncStatus: row.google_sync_status,
    googleSyncError: row.google_sync_error,
    googleSyncAttempts: row.google_sync_attempts,
    googleSyncedAt: row.google_synced_at,
    notes: row.notes,
    participants: (row.participants ?? []).map((p) => ({
      customerId: p.customer_id,
      attendance: p.attendance,
      firstName: p.customer?.first_name ?? null,
      lastName: p.customer?.last_name ?? null,
      email: p.customer?.email ?? null,
      phone: p.customer?.phone ?? null,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
