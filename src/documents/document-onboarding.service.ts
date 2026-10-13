import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import type {
  AssignmentResult,
  DocumentInstructorRow,
  DocumentTemplateRow,
} from './documents.types';

/**
 * Assigns every active, required instructor template to one instructor when
 * they join (season activation, or admin approval of a self sign-up), then
 * emails one `documents.assigned` listing the newly assigned documents.
 *
 * Never throws: activation and approval must succeed even when this fails,
 * so failures are logged and resolve to `null`.
 */
@Injectable()
export class DocumentOnboardingService {
  private readonly logger = new Logger(DocumentOnboardingService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly templates: DocumentTemplatesRepository,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly assignments: DocumentAssignmentsService,
    private readonly notifications: DocumentNotificationsService,
  ) {}

  /**
   * Assigns the required templates for `season`, else `CURRENT_SEASON`.
   * Templates without an uploaded PDF are not assigned. Resolves to the counts,
   * or `null` when there is no season or instructor, or the lookup failed.
   */
  async assignRequired(
    instructorId: string,
    season?: string | null,
  ): Promise<AssignmentResult | null> {
    return this.guard(instructorId, async () => {
      const instructor = await this.subjects.findInstructor(instructorId);
      if (!instructor) {
        this.logger.warn(
          `Instructor ${instructorId} not found; no documents assigned.`,
        );
        return null;
      }
      return this.assignTo(instructor, season);
    });
  }

  /** {@link assignRequired} for the instructor whose `auth_user_id` is `authUserId`. */
  async assignRequiredForAuthUser(
    authUserId: string,
    season?: string | null,
  ): Promise<AssignmentResult | null> {
    return this.guard(`auth user ${authUserId}`, async () => {
      const instructor =
        await this.subjects.findInstructorByAuthUser(authUserId);
      if (!instructor) {
        this.logger.warn(
          `No instructor for auth user ${authUserId}; no documents assigned.`,
        );
        return null;
      }
      return this.assignTo(instructor, season);
    });
  }

  private async assignTo(
    instructor: DocumentInstructorRow,
    season?: string | null,
  ): Promise<AssignmentResult | null> {
    const resolved =
      season?.trim() || this.config.get<string>('CURRENT_SEASON')?.trim();
    if (!resolved) {
      this.logger.warn(
        `No season (invite or CURRENT_SEASON) for instructor ${instructor.id}; ` +
          'no documents assigned.',
      );
      return null;
    }
    const required = (
      await this.templates.listActiveRequired('instructor')
    ).filter((template) => template.source_key);
    const created: DocumentTemplateRow[] = [];
    for (const template of required) {
      try {
        const outcome = await this.assignments.assignTemplateTo(
          template.id,
          resolved,
          [instructor.id],
        );
        if (outcome.createdSubjectIds.includes(instructor.id)) {
          created.push(template);
        }
      } catch (err) {
        this.logger.error(
          `Could not assign template ${template.id} to instructor ` +
            `${instructor.id}: ${errorMessage(err)}`,
        );
      }
    }
    if (created.length > 0) {
      void this.notifications
        .sendAssigned(instructor, created, resolved)
        .catch((err: unknown) => {
          this.logger.error(
            `Could not email instructor ${instructor.id} their documents: ` +
              errorMessage(err),
          );
        });
    }
    return {
      created: created.length,
      skipped: required.length - created.length,
    };
  }

  private async guard(
    who: string,
    run: () => Promise<AssignmentResult | null>,
  ): Promise<AssignmentResult | null> {
    try {
      return await run();
    } catch (err) {
      this.logger.error(
        `Auto-assigning documents to ${who} failed: ${errorMessage(err)}`,
      );
      return null;
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
