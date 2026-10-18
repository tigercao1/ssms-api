import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { torontoToday } from '../documents/certification-validity';
import { DocumentSubjectsRepository } from '../documents/document-subjects.repository';
import { MeDocumentsService } from '../documents/me-documents.service';
import {
  type GoLiveDocument,
  goLiveReadiness,
  type GoLiveReadiness,
  type GoLiveStatus,
  verifiedCertifications,
} from './go-live';
import { InstructorSyncRepository } from './instructor-sync.repository';
import { type InstructorSnapshot, isVisible } from './instructor-sync.types';
import { storefrontBaseUrl } from './storefront-url';

export const DEFAULT_STOREFRONT_LIVE_BASE_URL =
  'https://ssnow.club/pages/our-team/';

/** An instructor's go-live readiness and the snapshot to publish when ready. */
export interface GoLiveAssessment {
  readiness: GoLiveReadiness;
  publishable: InstructorSnapshot;
}

/** Loads the go-live inputs of an instructor and applies {@link goLiveReadiness}. */
@Injectable()
export class GoLiveService {
  constructor(
    private readonly repo: InstructorSyncRepository,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly documents: MeDocumentsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Readiness of the instructor, `null` when there is no such instructor.
   * `publishable` is the snapshot with only the verified certifications.
   */
  async assess(
    instructorId: string,
    today = torontoToday(),
  ): Promise<GoLiveAssessment | null> {
    const snapshot = await this.repo.loadSnapshot(instructorId);
    if (!snapshot) {
      return null;
    }
    const [certificationUploads, documents] = await Promise.all([
      this.subjects.listCertificationUploads(instructorId),
      isVisible(snapshot.instructor)
        ? this.documents.onboardingDocuments(instructorId)
        : Promise.resolve([]),
    ]);
    const goLive = {
      ...snapshot,
      certificationUploads,
      documents: documents.filter(
        (item): item is typeof item & GoLiveDocument =>
          item.assignmentId !== null,
      ),
    };
    return {
      readiness: goLiveReadiness(goLive, today),
      publishable: {
        ...snapshot,
        certifications: verifiedCertifications(goLive, today),
      },
    };
  }

  /** {@link status} of the caller's own instructor row; 404 without one. */
  async mine(authUserId: string): Promise<GoLiveStatus> {
    const instructor = await this.documents.instructorFor(authUserId);
    return this.status(instructor.id);
  }

  /** Readiness plus whether the storefront entry is live; 404 for an unknown instructor. */
  async status(instructorId: string): Promise<GoLiveStatus> {
    const [assessment, state] = await Promise.all([
      this.assess(instructorId),
      this.repo.getState(instructorId),
    ]);
    if (!assessment) {
      throw new NotFoundException(`Instructor ${instructorId} not found`);
    }
    const live = state?.last_status === 'active';
    const handle = state?.shopify_handle ?? null;
    return {
      live,
      ready: assessment.readiness.ready,
      liveUrl: live && handle ? `${this.liveBaseUrl()}${handle}` : null,
      missing: assessment.readiness.missing,
      certifications: assessment.readiness.certifications,
    };
  }

  private liveBaseUrl(): string {
    return storefrontBaseUrl(
      this.config,
      'STOREFRONT_LIVE_BASE_URL',
      DEFAULT_STOREFRONT_LIVE_BASE_URL,
    );
  }
}
