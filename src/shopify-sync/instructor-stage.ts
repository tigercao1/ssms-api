import { isCertificationSatisfied } from '../documents/certification-validity';
import type { ChecklistLockReason } from '../documents/documents.types';
import {
  isDocumentItemDone,
  lockFor,
  toCertificationItems,
} from '../documents/me-documents.service';
import type { GoLiveReadiness, GoLiveSnapshot } from './go-live';

export const INSTRUCTOR_STAGES = [
  'pending',
  'rejected',
  'deactivated',
  'onboarding',
  'in_review',
  'going_live',
  'live',
] as const;
export type InstructorStage = (typeof INSTRUCTOR_STAGES)[number];

const LOCKED_STAGE: Record<ChecklistLockReason, InstructorStage> = {
  pending_approval: 'pending',
  rejected: 'rejected',
  deactivated: 'deactivated',
};

export interface OnboardingProgress {
  done: number;
  inReview: number;
  total: number;
}

export function onboardingProgress(
  snapshot: GoLiveSnapshot,
  today: string,
): OnboardingProgress {
  const documents = snapshot.documents.filter((item) => item.required);
  const certifications = toCertificationItems(
    snapshot.certifications,
    snapshot.certificationUploads,
    today,
    false,
  );
  return {
    done:
      documents.filter(isDocumentItemDone).length +
      certifications.filter((item) => isCertificationSatisfied(item.state))
        .length,
    inReview: certifications.filter((item) => item.state === 'pending').length,
    total: documents.length + certifications.length,
  };
}

export function instructorStage(
  snapshot: GoLiveSnapshot,
  readiness: GoLiveReadiness,
  live: boolean,
  today: string,
): InstructorStage {
  const lock = lockFor(snapshot.instructor);
  if (lock) {
    return LOCKED_STAGE[lock.reason];
  }
  if (live) {
    return 'live';
  }
  if (readiness.ready) {
    return 'going_live';
  }
  const { done, inReview, total } = onboardingProgress(snapshot, today);
  const hasProfileGaps = readiness.missing.some((m) => m.group === 'profile');
  return inReview > 0 && done + inReview === total && !hasProfileGaps
    ? 'in_review'
    : 'onboarding';
}
