import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  certificationKey,
  certificationState,
  currentUploads,
  torontoToday,
} from './certification-validity';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import type {
  CertificationChecklistItem,
  CertificationUploadRow,
  Checklist,
  DocumentAssignmentRow,
  DocumentChecklistItem,
  DocumentInstructorRow,
} from './documents.types';

export const INSTRUCTOR_PROFILE_NOT_FOUND = 'Instructor profile not found';

function bySortOrder(a: DocumentAssignmentRow, b: DocumentAssignmentRow) {
  return (
    (a.template?.sort_order ?? 0) - (b.template?.sort_order ?? 0) ||
    (a.template?.title_en ?? '').localeCompare(b.template?.title_en ?? '')
  );
}

function toDocumentItem(row: DocumentAssignmentRow): DocumentChecklistItem {
  return {
    type: 'document',
    assignmentId: row.id,
    templateId: row.template_id,
    kind: row.template?.kind ?? 'sign',
    titleEn: row.template?.title_en ?? '',
    titleZh: row.template?.title_zh ?? null,
    descriptionEn: row.template?.description_en ?? null,
    descriptionZh: row.template?.description_zh ?? null,
    required: row.template?.required ?? true,
    status: row.status,
    season: row.season,
    assignedAt: row.assigned_at,
    viewedAt: row.viewed_at,
    completedAt: row.completed_at,
    dueAt: row.due_at,
  };
}

/**
 * The instructor's own documents (`/me/documents`). Every method resolves the
 * caller's instructor row from the JWT subject first.
 */
@Injectable()
export class MeDocumentsService {
  constructor(
    private readonly subjects: DocumentSubjectsRepository,
    private readonly assignments: DocumentAssignmentsRepository,
    private readonly config: ConfigService,
  ) {}

  /** Loads the caller's instructor row or throws 404. */
  async instructorFor(authUserId: string): Promise<DocumentInstructorRow> {
    const instructor = await this.subjects.findInstructorByAuthUser(authUserId);
    if (!instructor) {
      throw new NotFoundException(INSTRUCTOR_PROFILE_NOT_FOUND);
    }
    return instructor;
  }

  /**
   * Checklist for the current season: the season's non-archived assignments,
   * then one item per certification row with the state of its latest upload.
   * The season is `CURRENT_SEASON` when set, else the latest season among the
   * instructor's open assignments.
   */
  async checklist(
    authUserId: string,
    today = torontoToday(),
  ): Promise<Checklist> {
    const instructor = await this.instructorFor(authUserId);
    const [assignments, certifications, uploads] = await Promise.all([
      this.assignments.listForSubject('instructor', instructor.id),
      this.subjects.listCertifications(instructor.id),
      this.subjects.listCertificationUploads(instructor.id),
    ]);
    const open = assignments.filter((row) => row.status !== 'archived');
    const season = this.currentSeason(open);
    const documents = open
      .filter((row) => season === null || row.season === season || !row.season)
      .sort(bySortOrder)
      .map(toDocumentItem);
    const current = currentUploads(
      uploads.map((row) => ({ ...row, insertedAt: row.inserted_at })),
    );
    const certificationItems = certifications.map(
      (cert): CertificationChecklistItem => {
        const upload: CertificationUploadRow | undefined = current.get(
          certificationKey(cert.org, cert.track),
        );
        return {
          type: 'certification',
          org: cert.org,
          track: cert.track,
          level: cert.level,
          uploadId: upload?.id ?? null,
          reviewStatus: upload?.review_status ?? null,
          reviewNote: upload?.review_note ?? null,
          validUntil: upload?.valid_until ?? null,
          state: certificationState(
            upload
              ? {
                  reviewStatus: upload.review_status,
                  validUntil: upload.valid_until,
                }
              : null,
            today,
          ),
        };
      },
    );
    return { season, items: [...documents, ...certificationItems] };
  }

  private currentSeason(open: DocumentAssignmentRow[]): string | null {
    const configured = this.config.get<string>('CURRENT_SEASON')?.trim();
    if (configured) {
      return configured;
    }
    const seasons = open
      .map((row) => row.season)
      .filter((s): s is string => Boolean(s))
      .sort();
    return seasons.at(-1) ?? null;
  }
}
