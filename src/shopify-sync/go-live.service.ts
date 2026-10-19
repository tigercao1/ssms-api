import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { torontoToday } from '../documents/certification-validity';
import { DocumentSubjectsRepository } from '../documents/document-subjects.repository';
import { MeDocumentsService } from '../documents/me-documents.service';
import type {
  CertificationUploadRow,
  DocumentChecklistItem,
} from '../documents/documents.types';
import {
  type GoLiveDocument,
  type GoLiveHold,
  goLiveReadiness,
  type GoLiveReadiness,
  type GoLiveSnapshot,
  type GoLiveStatus,
  verifiedCertifications,
} from './go-live';
import { type InstructorStage, instructorStage } from './instructor-stage';
import { InstructorSyncRepository } from './instructor-sync.repository';
import {
  type InstructorShopifyState,
  type InstructorSnapshot,
  isVisible,
} from './instructor-sync.types';
import { LegacyRoster } from './legacy-roster';
import { storefrontBaseUrl } from './storefront-url';

export const DEFAULT_STOREFRONT_LIVE_BASE_URL =
  'https://ssnow.club/pages/our-team/';

export interface GoLiveAssessment {
  readiness: GoLiveReadiness;
  publishable: InstructorSnapshot;
  snapshot: GoLiveSnapshot;
}

function goLiveSnapshot(
  snapshot: InstructorSnapshot,
  certificationUploads: CertificationUploadRow[],
  documents: DocumentChecklistItem[],
): GoLiveSnapshot {
  return {
    ...snapshot,
    certificationUploads,
    documents: documents.filter(
      (item): item is typeof item & GoLiveDocument =>
        item.assignmentId !== null,
    ),
  };
}

function isLive(
  snapshot: InstructorSnapshot,
  state: InstructorShopifyState | null | undefined,
): boolean {
  return isVisible(snapshot.instructor) && state?.last_status === 'active';
}

@Injectable()
export class GoLiveService {
  private readonly logger = new Logger(GoLiveService.name);

  constructor(
    private readonly repo: InstructorSyncRepository,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly documents: MeDocumentsService,
    private readonly config: ConfigService,
    private readonly legacy: LegacyRoster,
  ) {}

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
    const goLive = goLiveSnapshot(snapshot, certificationUploads, documents);
    return {
      readiness: goLiveReadiness(goLive, today),
      publishable: {
        ...snapshot,
        certifications: verifiedCertifications(goLive, today),
      },
      snapshot: goLive,
    };
  }

  async stages(
    instructorIds: readonly string[],
    today = torontoToday(),
  ): Promise<Map<string, InstructorStage>> {
    const snapshots = await this.repo.loadSnapshots(instructorIds);
    const found = [...snapshots.keys()];
    const visible = [...snapshots.values()]
      .filter((snapshot) => isVisible(snapshot.instructor))
      .map((snapshot) => snapshot.instructor.id);
    const [uploads, documents, states] = await Promise.all([
      this.subjects.listCertificationUploadsFor(found),
      this.documents.onboardingDocumentsFor(visible),
      this.repo.getStates(visible),
    ]);
    return new Map(
      [...snapshots].map(([id, snapshot]) => {
        const goLive = goLiveSnapshot(
          snapshot,
          uploads.get(id) ?? [],
          documents.get(id) ?? [],
        );
        return [
          id,
          instructorStage(
            goLive,
            goLiveReadiness(goLive, today),
            isLive(snapshot, states.get(id)),
            today,
          ),
        ];
      }),
    );
  }

  async mine(authUserId: string): Promise<GoLiveStatus> {
    const instructor = await this.documents.instructorFor(authUserId);
    return this.status(instructor.id);
  }

  async status(
    instructorId: string,
    today = torontoToday(),
  ): Promise<GoLiveStatus> {
    const [assessment, state] = await Promise.all([
      this.assess(instructorId, today),
      this.repo.getState(instructorId),
    ]);
    if (!assessment) {
      throw new NotFoundException(`Instructor ${instructorId} not found`);
    }
    const live = isLive(assessment.publishable, state);
    const handle = state?.shopify_handle ?? null;
    return {
      live,
      stage: instructorStage(
        assessment.snapshot,
        assessment.readiness,
        live,
        today,
      ),
      ready: assessment.readiness.ready,
      liveUrl: live && handle ? `${this.liveBaseUrl()}${handle}` : null,
      missing: assessment.readiness.missing,
      certifications: assessment.readiness.certifications,
      hold: assessment.readiness.ready
        ? await this.hold(assessment.publishable, state)
        : null,
    };
  }

  private async hold(
    snapshot: InstructorSnapshot,
    state: InstructorShopifyState | null,
  ): Promise<GoLiveHold | null> {
    try {
      return await this.legacy.holdFor(snapshot.instructor, state);
    } catch (err) {
      this.logger.warn(
        `Could not check legacy pairing for ${snapshot.instructor.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private liveBaseUrl(): string {
    return storefrontBaseUrl(
      this.config,
      'STOREFRONT_LIVE_BASE_URL',
      DEFAULT_STOREFRONT_LIVE_BASE_URL,
    );
  }
}
