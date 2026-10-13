import { BadRequestException, Injectable } from '@nestjs/common';
import {
  type ClassFilter,
  ClassesRepository,
  type ClassRow,
} from './classes.repository';
import type { Attendance, ClassSource, ClassStatus } from './lessons.types';

export const CLASS_RANGE_INVALID = '`to` must be after `from`';

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
  notes: string | null;
  participants: AdminClassParticipant[];
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ClassesService {
  constructor(private readonly repo: ClassesRepository) {}

  async list(filter: ClassFilter): Promise<AdminClass[]> {
    if (
      filter.from &&
      filter.to &&
      Date.parse(filter.to) <= Date.parse(filter.from)
    ) {
      throw new BadRequestException(CLASS_RANGE_INVALID);
    }
    return (await this.repo.list(filter)).map(toAdminClass);
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
