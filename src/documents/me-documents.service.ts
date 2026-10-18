import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SeasonsService } from '../seasons/seasons.service';
import {
  certificationKey,
  certificationState,
  currentUploads,
  isCertificationSatisfied,
  torontoToday,
} from './certification-validity';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import type {
  CertificationChecklistItem,
  CertificationUploadRow,
  Checklist,
  ChecklistItem,
  ChecklistLockReason,
  DocumentAssignmentRow,
  DocumentChecklistItem,
  DocumentInstructorRow,
  DocumentTemplateRow,
  InstructorCertificationRow,
} from './documents.types';
import { signerLanguages } from './template-versions';

export const INSTRUCTOR_PROFILE_NOT_FOUND = 'Instructor profile not found';
export const PENDING_APPROVAL =
  'Your profile is being reviewed; onboarding opens once an admin approves you';
export const PENDING_APPROVAL_REASON: ChecklistLockReason = 'pending_approval';
export const REJECTED =
  'Your profile was not approved, so onboarding documents are not available';
export const REJECTED_REASON: ChecklistLockReason = 'rejected';
export const DEACTIVATED =
  'Your account is inactive, so onboarding documents and uploads are not available';
export const DEACTIVATED_REASON: ChecklistLockReason = 'deactivated';

function lockFor(
  instructor: DocumentInstructorRow,
): { message: string; reason: ChecklistLockReason } | null {
  if (!instructor.is_active) {
    return { message: DEACTIVATED, reason: DEACTIVATED_REASON };
  }
  if (instructor.approval_status === 'approved') {
    return null;
  }
  return instructor.approval_status === 'rejected'
    ? { message: REJECTED, reason: REJECTED_REASON }
    : { message: PENDING_APPROVAL, reason: PENDING_APPROVAL_REASON };
}

export function isDocumentItemDone(
  item: Pick<DocumentChecklistItem, 'required' | 'status'>,
): boolean {
  return !item.required || item.status === 'completed';
}

export function isOnboardingComplete(items: readonly ChecklistItem[]): boolean {
  return items.every((item) =>
    item.type === 'certification'
      ? isCertificationSatisfied(item.state)
      : isDocumentItemDone(item),
  );
}

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
    languages: row.template ? signerLanguages(row.template) : [],
  };
}

function toPreviewItem(template: DocumentTemplateRow): DocumentChecklistItem {
  return {
    type: 'document',
    assignmentId: null,
    templateId: template.id,
    kind: template.kind,
    titleEn: template.title_en,
    titleZh: template.title_zh,
    descriptionEn: template.description_en,
    descriptionZh: template.description_zh,
    required: template.required,
    status: null,
    season: template.season,
    assignedAt: null,
    viewedAt: null,
    completedAt: null,
    dueAt: null,
    languages: signerLanguages(template),
  };
}

function toCertificationItems(
  certifications: InstructorCertificationRow[],
  uploads: CertificationUploadRow[],
  today: string,
  locked: boolean,
): CertificationChecklistItem[] {
  const current = currentUploads(
    uploads.map((row) => ({ ...row, insertedAt: row.inserted_at })),
  );
  return certifications.map((cert): CertificationChecklistItem => {
    const upload: CertificationUploadRow | undefined = current.get(
      certificationKey(cert.org, cert.track),
    );
    return {
      type: 'certification',
      org: cert.org,
      track: cert.track,
      level: cert.level,
      uploadId: locked ? null : (upload?.id ?? null),
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
  });
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
    private readonly templates: DocumentTemplatesRepository,
    private readonly seasons: SeasonsService,
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
   * {@link instructorFor}, then 403 unless the instructor is active and approved:
   * `reason: 'deactivated'` for an inactive instructor, `'rejected'` for a
   * rejected one, else `'pending_approval'`.
   */
  async approvedInstructorFor(
    authUserId: string,
  ): Promise<DocumentInstructorRow> {
    const instructor = await this.instructorFor(authUserId);
    const lock = lockFor(instructor);
    if (lock) {
      throw new ForbiddenException(lock);
    }
    return instructor;
  }

  /**
   * Checklist for the current season: the season's non-archived assignments,
   * then one item per certification row with the state of its latest upload.
   * The season is the current season, else the latest season among the
   * instructor's open assignments.
   *
   * Until the instructor is approved the checklist is `locked` and a preview:
   * one item per `live` template published to `all` for the season, without
   * an assignment, and the certification items without their upload id.
   * A rejected or deactivated instructor gets that `lockReason` and no items.
   * `complete` is {@link isOnboardingComplete} of the items, and `false` while
   * locked.
   */
  async checklist(
    authUserId: string,
    today = torontoToday(),
  ): Promise<Checklist> {
    const instructor = await this.instructorFor(authUserId);
    const lock = lockFor(instructor);
    if (
      lock?.reason === REJECTED_REASON ||
      lock?.reason === DEACTIVATED_REASON
    ) {
      return {
        season: await this.currentSeason([]),
        locked: true,
        lockReason: lock.reason,
        complete: false,
        items: [],
      };
    }
    const locked = lock !== null;
    const [certifications, uploads] = await Promise.all([
      this.subjects.listCertifications(instructor.id),
      this.subjects.listCertificationUploads(instructor.id),
    ]);
    const certificationItems = toCertificationItems(
      certifications,
      uploads,
      today,
      locked,
    );
    if (locked) {
      const season = await this.currentSeason([]);
      const published = await this.templates.listLiveForAll(
        'instructor',
        season,
      );
      return {
        season,
        locked: true,
        lockReason: PENDING_APPROVAL_REASON,
        complete: false,
        items: [...published.map(toPreviewItem), ...certificationItems],
      };
    }
    const { season, documents } = await this.currentDocuments(instructor.id);
    const items = [...documents, ...certificationItems];
    return {
      season,
      locked: false,
      lockReason: null,
      complete: isOnboardingComplete(items),
      items,
    };
  }

  async onboardingComplete(
    instructorId: string,
    today = torontoToday(),
  ): Promise<boolean> {
    const [{ documents }, certifications, uploads] = await Promise.all([
      this.currentDocuments(instructorId),
      this.subjects.listCertifications(instructorId),
      this.subjects.listCertificationUploads(instructorId),
    ]);
    return isOnboardingComplete([
      ...documents,
      ...toCertificationItems(certifications, uploads, today, false),
    ]);
  }

  async onboardingDocuments(
    instructorId: string,
  ): Promise<DocumentChecklistItem[]> {
    return (await this.currentDocuments(instructorId)).documents;
  }

  private async currentDocuments(
    instructorId: string,
  ): Promise<{ season: string | null; documents: DocumentChecklistItem[] }> {
    const assignments = await this.assignments.listForSubject(
      'instructor',
      instructorId,
    );
    const open = assignments.filter((row) => row.status !== 'archived');
    const season = await this.currentSeason(open);
    const documents = open
      .filter((row) => season === null || row.season === season || !row.season)
      .sort(bySortOrder)
      .map(toDocumentItem);
    return { season, documents };
  }

  private async currentSeason(
    open: DocumentAssignmentRow[],
  ): Promise<string | null> {
    const current = await this.seasons.currentKey();
    if (current) {
      return current;
    }
    const seasons = open
      .map((row) => row.season)
      .filter((s): s is string => Boolean(s))
      .sort();
    return seasons.at(-1) ?? null;
  }
}
