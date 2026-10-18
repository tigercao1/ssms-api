import {
  certificationKey,
  currentUploads,
  daysBetween,
} from '../documents/certification-validity';
import type {
  CertificationUploadRow,
  DocumentChecklistItem,
} from '../documents/documents.types';
import { isDocumentItemDone } from '../documents/me-documents.service';
import {
  type InstructorSnapshot,
  isVisible,
  type SyncCertRow,
} from './instructor-sync.types';

export type GoLiveProfileField =
  | 'displayNameEn'
  | 'bio'
  | 'photo'
  | 'locations'
  | 'languages'
  | 'courseLevels';

export type GoLiveMissingItem =
  | { group: 'profile'; field: GoLiveProfileField }
  | { group: 'certification'; reason: 'none_verified' }
  | {
      group: 'onboarding';
      assignmentId: string;
      titleEn: string;
      titleZh: string | null;
    };

export type GoLiveCertificationStatus =
  | 'verified'
  | 'pending'
  | 'rejected'
  | 'expired'
  | 'no_proof'
  | 'level_mismatch';

export interface GoLiveCertification {
  org: SyncCertRow['org'];
  track: SyncCertRow['track'];
  level: number;
  status: GoLiveCertificationStatus;
  validUntil: string | null;
}

/** The fields of a certification upload the go-live rule reads. */
export type GoLiveUpload = Pick<
  CertificationUploadRow,
  | 'org'
  | 'track'
  | 'review_status'
  | 'valid_until'
  | 'verified_level'
  | 'inserted_at'
>;

/** A current-season onboarding document item that has an assignment. */
export type GoLiveDocument = Pick<
  DocumentChecklistItem,
  'titleEn' | 'titleZh' | 'required' | 'status'
> & { assignmentId: string };

/** Everything the go-live rule reads about one instructor. */
export interface GoLiveSnapshot extends InstructorSnapshot {
  certificationUploads: GoLiveUpload[];
  documents: GoLiveDocument[];
}

export interface GoLiveReadiness {
  ready: boolean;
  missing: GoLiveMissingItem[];
  certifications: GoLiveCertification[];
}

/** `GET /me/go-live` and `GET /admin/instructors/:id/go-live`. */
export interface GoLiveStatus extends GoLiveReadiness {
  live: boolean;
  liveUrl: string | null;
}

function nonBlank(value: string | null | undefined): boolean {
  return (value?.trim() ?? '') !== '';
}

function certificationStatus(
  cert: SyncCertRow,
  upload: GoLiveUpload | undefined,
  today: string,
): GoLiveCertificationStatus {
  if (!upload) {
    return 'no_proof';
  }
  if (upload.review_status === 'rejected') {
    return 'rejected';
  }
  if (upload.review_status === 'pending') {
    return 'pending';
  }
  if (daysBetween(today, upload.valid_until) < 0) {
    return 'expired';
  }
  if (upload.verified_level == null || upload.verified_level < cert.level) {
    return 'level_mismatch';
  }
  return 'verified';
}

function byOrgAndTrack(a: SyncCertRow, b: SyncCertRow): number {
  return a.org.localeCompare(b.org) || a.track.localeCompare(b.track);
}

function certificationRows(
  snapshot: GoLiveSnapshot,
  today: string,
): { cert: SyncCertRow; status: GoLiveCertification }[] {
  const current = currentUploads(
    snapshot.certificationUploads.map((upload) => ({
      ...upload,
      insertedAt: upload.inserted_at,
    })),
  );
  return [...snapshot.certifications].sort(byOrgAndTrack).map((cert) => {
    const upload = current.get(certificationKey(cert.org, cert.track));
    return {
      cert,
      status: {
        org: cert.org,
        track: cert.track,
        level: cert.level,
        status: certificationStatus(cert, upload, today),
        validUntil: upload?.valid_until ?? null,
      },
    };
  });
}

function missingProfileFields(snapshot: GoLiveSnapshot): GoLiveProfileField[] {
  const { instructor } = snapshot;
  const checks: [GoLiveProfileField, boolean][] = [
    ['displayNameEn', nonBlank(instructor.display_name_en)],
    ['bio', nonBlank(instructor.bio_en) || nonBlank(instructor.bio_zh)],
    ['photo', nonBlank(instructor.profile_photo_url)],
    ['locations', snapshot.locations.length > 0],
    ['languages', snapshot.languages.length > 0],
    ['courseLevels', snapshot.courseLevels.length > 0],
  ];
  return checks.filter(([, present]) => !present).map(([field]) => field);
}

/**
 * Whether an instructor may be live on the storefront. An approved, active
 * instructor is ready when the required profile fields are filled, at least
 * one certification is `verified` and every required current-season document
 * is completed; `missing` lists what is not. Anyone else is not ready and has
 * nothing `missing`. `certifications` always carries every declared
 * certification with the status of its current upload.
 */
export function goLiveReadiness(
  snapshot: GoLiveSnapshot,
  today: string,
): GoLiveReadiness {
  const certifications = certificationRows(snapshot, today).map(
    (row) => row.status,
  );
  if (!isVisible(snapshot.instructor)) {
    return { ready: false, missing: [], certifications };
  }
  const missing: GoLiveMissingItem[] = [
    ...missingProfileFields(snapshot).map((field) => ({
      group: 'profile' as const,
      field,
    })),
  ];
  if (!certifications.some((c) => c.status === 'verified')) {
    missing.push({ group: 'certification', reason: 'none_verified' });
  }
  for (const document of snapshot.documents) {
    if (!isDocumentItemDone(document)) {
      missing.push({
        group: 'onboarding',
        assignmentId: document.assignmentId,
        titleEn: document.titleEn,
        titleZh: document.titleZh,
      });
    }
  }
  return { ready: missing.length === 0, missing, certifications };
}

/** The declared certifications whose current upload makes them `verified`. */
export function verifiedCertifications(
  snapshot: GoLiveSnapshot,
  today: string,
): SyncCertRow[] {
  return certificationRows(snapshot, today)
    .filter((row) => row.status.status === 'verified')
    .map((row) => row.cert);
}
