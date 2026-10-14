import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { hasCode, PG_UNIQUE_VIOLATION } from '../database/db-result';
import { utcToday } from './certification-validity';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import {
  DocumentNotificationsService,
  type DocumentEmailTemplate,
} from './document-notifications.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import type {
  Assignment,
  AssignmentResult,
  InstructorDocuments,
  NewAssignmentRow,
} from './documents.types';
import { toAssignment, toCertUploads } from './documents.presenters';
import type { CreateAssignmentsDto } from './dto/assignment.dto';
import { TEMPLATE_NOT_FOUND } from './document-templates.service';

export const ASSIGNMENT_NOT_FOUND = 'Document assignment not found';
export const INSTRUCTOR_NOT_FOUND = 'Instructor not found';
export const ASSIGN_TARGET_REQUIRED =
  'Send either instructorIds or allActiveInstructors: true, not both';
export const TEMPLATE_NOT_ASSIGNABLE =
  'Only active instructor templates with an uploaded PDF can be assigned';

/** Which instructors {@link DocumentAssignmentsService.assignTemplateTo} newly assigned. */
export interface TemplateAssignmentOutcome {
  createdSubjectIds: string[];
  skipped: number;
}

/**
 * Admin side of document assignments: create per season (idempotent), list
 * per instructor, archive. Other modules can call {@link assignTemplate}
 * directly to assign without going through HTTP. Each instructor who gets a
 * new assignment from the admin route is emailed `documents.assigned` in the
 * background; instructors who already held it are not.
 */
@Injectable()
export class DocumentAssignmentsService {
  private readonly logger = new Logger(DocumentAssignmentsService.name);

  constructor(
    private readonly assignments: DocumentAssignmentsRepository,
    private readonly templates: DocumentTemplatesRepository,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly audit: AuditService,
    private readonly notifications: DocumentNotificationsService,
  ) {}

  /** `POST /admin/documents/assignments`. */
  async create(
    dto: CreateAssignmentsDto,
    actor: AuditActor,
  ): Promise<AssignmentResult> {
    const all = dto.allActiveInstructors === true;
    if (all === (dto.instructorIds !== undefined)) {
      throw new BadRequestException(ASSIGN_TARGET_REQUIRED);
    }
    const template = await this.templates.findById(dto.templateId);
    if (!template) {
      throw new NotFoundException(TEMPLATE_NOT_FOUND);
    }
    if (
      !template.is_active ||
      template.audience !== 'instructor' ||
      !template.source_key
    ) {
      throw new BadRequestException(TEMPLATE_NOT_ASSIGNABLE);
    }
    const instructorIds = all
      ? await this.subjects.listActiveApprovedInstructorIds()
      : await this.knownInstructors(dto.instructorIds ?? []);
    const outcome = await this.assignTemplateTo(
      dto.templateId,
      dto.season,
      instructorIds,
    );
    const result = toResult(outcome);
    await this.audit.record({
      action: AUDIT_ACTIONS.documentAssignmentCreate,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: dto.templateId,
      metadata: {
        season: dto.season,
        allActiveInstructors: all,
        requested: instructorIds.length,
        ...result,
      },
    });
    void this.notifyAssigned(template, dto.season, outcome.createdSubjectIds);
    return result;
  }

  /**
   * Assigns a template to instructors for a season. Instructors who already
   * hold a non-archived assignment of it for that season are skipped, so
   * repeating the call is safe (the open-assignment unique index backs this up
   * under concurrency).
   */
  async assignTemplate(
    templateId: string,
    season: string,
    instructorIds: string[],
  ): Promise<AssignmentResult> {
    return toResult(
      await this.assignTemplateTo(templateId, season, instructorIds),
    );
  }

  /** {@link assignTemplate}, returning which instructors were newly assigned. */
  async assignTemplateTo(
    templateId: string,
    season: string,
    instructorIds: string[],
  ): Promise<TemplateAssignmentOutcome> {
    const unique = [...new Set(instructorIds)];
    const open = await this.assignments.findOpenSubjectIds(
      templateId,
      season,
      'instructor',
      unique,
    );
    const rows: NewAssignmentRow[] = unique
      .filter((id) => !open.has(id))
      .map((subjectId) => ({
        template_id: templateId,
        subject_type: 'instructor',
        subject_id: subjectId,
        season,
      }));
    let created: string[];
    try {
      await this.assignments.insertMany(rows);
      created = rows.map((row) => row.subject_id);
    } catch (err) {
      if (!hasCode(err, PG_UNIQUE_VIOLATION)) {
        throw err;
      }
      created = [];
      for (const row of rows) {
        if (await this.assignments.insertIfAbsent(row)) {
          created.push(row.subject_id);
        }
      }
    }
    return {
      createdSubjectIds: created,
      skipped: unique.length - created.length,
    };
  }

  /** `GET /admin/instructors/:id/documents`. */
  async listForInstructor(instructorId: string): Promise<InstructorDocuments> {
    const instructor = await this.subjects.findInstructor(instructorId);
    if (!instructor) {
      throw new NotFoundException(INSTRUCTOR_NOT_FOUND);
    }
    const [assignments, uploads] = await Promise.all([
      this.assignments.listForSubject('instructor', instructorId),
      this.subjects.listCertificationUploads(instructorId),
    ]);
    return {
      assignments: assignments.map(toAssignment),
      certificationUploads: toCertUploads(uploads, utcToday()),
    };
  }

  /** `POST /admin/documents/assignments/:id/archive`; archiving twice is a no-op. */
  async archive(id: string, actor: AuditActor): Promise<Assignment> {
    const before = await this.assignments.findById(id);
    if (!before) {
      throw new NotFoundException(ASSIGNMENT_NOT_FOUND);
    }
    if (before.status === 'archived') {
      return toAssignment(before);
    }
    const row = await this.assignments.update(id, { status: 'archived' });
    if (!row) {
      throw new NotFoundException(ASSIGNMENT_NOT_FOUND);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.documentAssignmentArchive,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_assignment',
      targetId: id,
      metadata: {
        templateId: row.template_id,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        season: row.season,
        previousStatus: before.status,
      },
    });
    return toAssignment(row);
  }

  private async notifyAssigned(
    template: DocumentEmailTemplate,
    season: string,
    instructorIds: string[],
  ): Promise<void> {
    for (const id of instructorIds) {
      try {
        const instructor = await this.subjects.findInstructor(id);
        if (instructor) {
          await this.notifications.sendAssigned(instructor, [template], season);
        }
      } catch (err) {
        this.logger.error(
          `Could not email instructor ${id} about template ${template.id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async knownInstructors(ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    const found = await this.subjects.existingInstructorIds(unique);
    const unknown = unique.filter((id) => !found.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown instructor id(s): ${unknown.join(', ')}`,
      );
    }
    return unique;
  }
}

function toResult(outcome: TemplateAssignmentOutcome): AssignmentResult {
  return {
    created: outcome.createdSubjectIds.length,
    skipped: outcome.skipped,
  };
}
