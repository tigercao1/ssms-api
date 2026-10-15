import { Injectable, Logger } from '@nestjs/common';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import type {
  AssignmentResult,
  DocumentInstructorRow,
  DocumentTemplateRow,
} from './documents.types';

export interface AssignPublishedOptions {
  /** Open the email with the approval (admin approval only). */
  approved?: boolean;
}

/**
 * Assigns every `live` template published to `all` instructors, each for its
 * own season, to one approved instructor (on admin approval, or on activation
 * of an already-approved instructor), then emails one `documents.assigned`
 * listing the newly assigned documents. Instructors who are not approved get
 * nothing. Existing assignments are skipped, so repeating it is safe.
 *
 * Never throws: activation and approval must succeed even when this fails,
 * so failures are logged and resolve to `null`.
 */
@Injectable()
export class DocumentOnboardingService {
  private readonly logger = new Logger(DocumentOnboardingService.name);

  constructor(
    private readonly templates: DocumentTemplatesRepository,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly assignments: DocumentAssignmentsService,
    private readonly notifications: DocumentNotificationsService,
  ) {}

  /**
   * Assigns the published templates. `approved: true` opens the email with
   * the approval. Resolves to the counts, or `null` when the instructor is
   * missing or not approved, or the lookup failed.
   */
  async assignPublished(
    instructorId: string,
    options: AssignPublishedOptions = {},
  ): Promise<AssignmentResult | null> {
    return this.guard(instructorId, async () => {
      const instructor = await this.subjects.findInstructor(instructorId);
      if (!instructor) {
        this.logger.warn(
          `Instructor ${instructorId} not found; no documents assigned.`,
        );
        return null;
      }
      return this.assignTo(instructor, options);
    });
  }

  /** {@link assignPublished} for the instructor whose `auth_user_id` is `authUserId`. */
  async assignPublishedForAuthUser(
    authUserId: string,
    options: AssignPublishedOptions = {},
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
      return this.assignTo(instructor, options);
    });
  }

  private async assignTo(
    instructor: DocumentInstructorRow,
    options: AssignPublishedOptions,
  ): Promise<AssignmentResult | null> {
    if (instructor.approval_status !== 'approved') {
      return null;
    }
    const published = (
      await this.templates.listLiveForAll('instructor')
    ).flatMap((template) =>
      template.source_key && template.season
        ? [{ template, season: template.season }]
        : [],
    );
    const created: DocumentTemplateRow[] = [];
    for (const { template, season } of published) {
      try {
        const outcome = await this.assignments.assignTemplateTo(
          template.id,
          season,
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
      const seasons = [...new Set(created.map((t) => t.season))];
      void this.notifications
        .sendAssigned(
          instructor,
          created,
          seasons.length === 1 ? seasons[0] : null,
          { approved: options.approved === true },
        )
        .catch((err: unknown) => {
          this.logger.error(
            `Could not email instructor ${instructor.id} their documents: ` +
              errorMessage(err),
          );
        });
    }
    return {
      created: created.length,
      skipped: published.length - created.length,
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
