import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { SeasonsService } from '../seasons/seasons.service';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import {
  DocumentAssignmentsService,
  TEMPLATE_NOT_ASSIGNABLE,
  type TemplateAssignmentOutcome,
} from './document-assignments.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import { DocumentTemplatesService } from './document-templates.service';
import type {
  PublishPreview,
  PublishResult,
  Template,
} from './documents.types';
import type { ChangeAudienceDto, PublishTemplateDto } from './dto/template.dto';

export const TEMPLATE_ALREADY_LIVE = 'This document is already published';
export const TEMPLATE_NOT_LIVE = 'Only a published document can be retired';
export const PUBLISH_NEEDS_SOURCE = 'Upload the PDF before publishing';
export const PUBLISH_NEEDS_FIELDS =
  'Place at least one field before publishing a document to sign';
export const PUBLISH_ALL_NEEDS_INSTRUCTORS =
  'Only instructor documents can be published to all instructors';
export const PUBLISH_INSTRUCTORS_NEED_SELECTED =
  'instructorIds can only be sent when publishing to selected instructors';
export const AUDIENCE_NEEDS_LIVE =
  "Only a published document's audience can be changed";
export const AUDIENCE_UNCHANGED = 'This document already has that audience';
export const SEASON_REQUIRED = 'Choose a season; no current season is set up';

/**
 * The template lifecycle: `draft` → `live` (publish) → `retired` (retire),
 * and `retired` → `live` again. Publishing to `all` assigns the template to
 * every approved, active instructor for its season and emails each one who
 * was newly assigned; instructors approved later get it on approval.
 * Publishing to `selected` assigns the listed `instructorIds` the same way.
 */
@Injectable()
export class DocumentPublishingService {
  constructor(
    private readonly seasons: SeasonsService,
    private readonly repo: DocumentTemplatesRepository,
    private readonly templates: DocumentTemplatesService,
    private readonly assignments: DocumentAssignmentsService,
    private readonly assignmentRows: DocumentAssignmentsRepository,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly audit: AuditService,
  ) {}

  /** `GET /admin/documents/templates/:id/publish-preview`. */
  async preview(id: string, season?: string): Promise<PublishPreview> {
    await this.templates.load(id);
    const resolved = await this.resolveSeason(season);
    const [approved, pendingCount] = await Promise.all([
      this.subjects.listActiveApprovedInstructorIds(),
      this.subjects.countPendingInstructors(),
    ]);
    const assigned = await this.assignmentRows.findOpenSubjectIds(
      id,
      resolved,
      'instructor',
      approved,
    );
    return {
      season: resolved,
      approvedCount: approved.length,
      pendingCount,
      alreadyAssignedCount: assigned.size,
    };
  }

  /** `POST /admin/documents/templates/:id/publish`, from `draft` or `retired`. */
  async publish(
    id: string,
    dto: PublishTemplateDto,
    actor: AuditActor,
    now = new Date(),
  ): Promise<PublishResult> {
    const before = await this.templates.load(id);
    if (before.status === 'live') {
      throw new ConflictException(TEMPLATE_ALREADY_LIVE);
    }
    if (!before.source_key) {
      throw new BadRequestException(PUBLISH_NEEDS_SOURCE);
    }
    if (before.kind === 'sign' && before.fields.length === 0) {
      throw new BadRequestException(PUBLISH_NEEDS_FIELDS);
    }
    if (dto.assignTo === 'all' && before.audience !== 'instructor') {
      throw new BadRequestException(PUBLISH_ALL_NEEDS_INSTRUCTORS);
    }
    if (dto.instructorIds !== undefined && dto.assignTo !== 'selected') {
      throw new BadRequestException(PUBLISH_INSTRUCTORS_NEED_SELECTED);
    }
    if (dto.instructorIds?.length && before.audience !== 'instructor') {
      throw new BadRequestException(TEMPLATE_NOT_ASSIGNABLE);
    }
    const selected = await this.assignments.knownInstructors(
      dto.instructorIds ?? [],
    );
    const season = await this.resolveSeason(dto.season);
    const row = await this.repo.updateIfStatus(id, ['draft', 'retired'], {
      status: 'live',
      assign_to: dto.assignTo,
      season,
      published_at: now.toISOString(),
      published_by: actor.userId ?? null,
      updated_by: actor.userId ?? null,
    });
    if (!row) {
      throw new ConflictException(TEMPLATE_ALREADY_LIVE);
    }
    const outcome: TemplateAssignmentOutcome =
      dto.assignTo === 'all'
        ? await this.assignments.assignTemplateTo(
            id,
            season,
            await this.subjects.listActiveApprovedInstructorIds(),
          )
        : await this.assignments.assignTemplateTo(id, season, selected);
    const created = outcome.createdSubjectIds.length;
    await this.audit.record({
      action: AUDIT_ACTIONS.documentTemplatePublish,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: id,
      metadata: {
        from: before.status,
        assignTo: dto.assignTo,
        season,
        created,
        skipped: outcome.skipped,
      },
    });
    void this.assignments.notifyAssigned(
      row,
      season,
      outcome.createdSubjectIds,
    );
    return {
      template: await this.templates.present(row),
      created,
      skipped: outcome.skipped,
    };
  }

  /** `POST /admin/documents/templates/:id/audience`, on a `live` template only. */
  async changeAudience(
    id: string,
    dto: ChangeAudienceDto,
    actor: AuditActor,
  ): Promise<PublishResult> {
    const before = await this.templates.load(id);
    if (before.status !== 'live') {
      throw new ConflictException(AUDIENCE_NEEDS_LIVE);
    }
    if (before.assign_to === dto.assignTo) {
      throw new ConflictException(AUDIENCE_UNCHANGED);
    }
    if (dto.assignTo === 'all' && before.audience !== 'instructor') {
      throw new BadRequestException(PUBLISH_ALL_NEEDS_INSTRUCTORS);
    }
    const season = before.season ?? (await this.resolveSeason());
    const row = await this.repo.updateIfStatus(id, ['live'], {
      assign_to: dto.assignTo,
      season,
      updated_by: actor.userId ?? null,
    });
    if (!row) {
      throw new ConflictException(AUDIENCE_NEEDS_LIVE);
    }
    const outcome: TemplateAssignmentOutcome =
      dto.assignTo === 'all'
        ? await this.assignments.assignTemplateTo(
            id,
            season,
            await this.subjects.listActiveApprovedInstructorIds(),
          )
        : { createdSubjectIds: [], skipped: 0 };
    const created = outcome.createdSubjectIds.length;
    await this.audit.record({
      action: AUDIT_ACTIONS.documentTemplateAudienceChange,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: id,
      metadata: {
        from: before.assign_to,
        assignTo: dto.assignTo,
        season,
        created,
        skipped: outcome.skipped,
      },
    });
    void this.assignments.notifyAssigned(
      row,
      season,
      outcome.createdSubjectIds,
    );
    return {
      template: await this.templates.present(row),
      created,
      skipped: outcome.skipped,
    };
  }

  /** `POST /admin/documents/templates/:id/retire`; existing assignments are kept. */
  async retire(id: string, actor: AuditActor): Promise<Template> {
    const before = await this.templates.load(id);
    const row = await this.repo.updateIfStatus(id, ['live'], {
      status: 'retired',
      updated_by: actor.userId ?? null,
    });
    if (!row) {
      throw new ConflictException(TEMPLATE_NOT_LIVE);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.documentTemplateRetire,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: id,
      metadata: {
        from: before.status,
        assignTo: before.assign_to,
        season: before.season,
      },
    });
    return this.templates.present(row);
  }

  private async resolveSeason(season?: string): Promise<string> {
    const requested = season?.trim();
    if (requested) {
      return (await this.seasons.assertKnown(requested)).key;
    }
    const current = await this.seasons.currentKey();
    if (!current) {
      throw new BadRequestException(SEASON_REQUIRED);
    }
    return current;
  }
}
