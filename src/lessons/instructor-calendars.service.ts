import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { InstructorCalendarsRepository } from './instructor-calendars.repository';

export const INSTRUCTOR_NOT_FOUND = 'Instructor not found';

export interface InstructorGoogleCalendar {
  instructorId: string;
  googleCalendarId: string | null;
  updatedAt: string | null;
}

@Injectable()
export class InstructorCalendarsService {
  constructor(
    private readonly repo: InstructorCalendarsRepository,
    private readonly audit: AuditService,
  ) {}

  async get(instructorId: string): Promise<InstructorGoogleCalendar> {
    await this.requireInstructor(instructorId);
    const row = await this.repo.find(instructorId);
    return {
      instructorId,
      googleCalendarId: row?.google_calendar_id ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  }

  async set(
    instructorId: string,
    googleCalendarId: string | null,
    actor: AuditActor,
  ): Promise<InstructorGoogleCalendar> {
    await this.requireInstructor(instructorId);
    const before = await this.repo.find(instructorId);
    const next = googleCalendarId?.trim() || null;
    let result: InstructorGoogleCalendar;
    if (next === null) {
      await this.repo.remove(instructorId);
      result = { instructorId, googleCalendarId: null, updatedAt: null };
    } else {
      const row = await this.repo.upsert(
        instructorId,
        next,
        actor.userId ?? null,
      );
      result = {
        instructorId,
        googleCalendarId: row.google_calendar_id,
        updatedAt: row.updated_at,
      };
    }
    const previous = before?.google_calendar_id ?? null;
    if (previous !== result.googleCalendarId) {
      await this.audit.record({
        action: AUDIT_ACTIONS.instructorGoogleCalendarUpdate,
        actor: { ...actor, role: 'admin' },
        targetType: 'instructor',
        targetId: instructorId,
        metadata: { from: previous, to: result.googleCalendarId },
      });
    }
    return result;
  }

  private async requireInstructor(instructorId: string): Promise<void> {
    if (!(await this.repo.instructorExists(instructorId))) {
      throw new NotFoundException(INSTRUCTOR_NOT_FOUND);
    }
  }
}
