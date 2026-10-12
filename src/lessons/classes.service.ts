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
  purchaseId: string | null;
  attendance: Attendance;
  name: string | null;
  email: string | null;
  phone: string | null;
  wechatId: string | null;
}

export interface AdminClass {
  id: string;
  instructorId: string;
  instructorName: string | null;
  instructorNameZh: string | null;
  lessonProductId: string | null;
  lessonProductTitle: string | null;
  lessonVariantTitle: string | null;
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

function toAdminClass(row: ClassRow): AdminClass {
  return {
    id: row.id,
    instructorId: row.instructor_id,
    instructorName: row.instructor?.display_name_en ?? null,
    instructorNameZh: row.instructor?.display_name_zh ?? null,
    lessonProductId: row.lesson_product_id,
    lessonProductTitle: row.lesson_product?.product_title ?? null,
    lessonVariantTitle: row.lesson_product?.variant_title ?? null,
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
      purchaseId: p.purchase_id,
      attendance: p.attendance,
      name: p.customer?.name ?? null,
      email: p.customer?.email ?? null,
      phone: p.customer?.phone ?? null,
      wechatId: p.customer?.wechat_id ?? null,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
