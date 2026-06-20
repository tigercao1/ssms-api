/**
 * T3.3 — Certification display-string formatter (pure functions).
 *
 * Computes the human-readable display strings for instructor certifications and
 * trainer status from the structured data, per CERTIFICATION_STRUCTURE.md
 * § Display strings. The actual `partialComponents` are internal-only and are
 * never reflected in the string beyond the generic "Partial" suffix.
 *
 * These functions are intentionally dependency-free and side-effect-free so
 * they can be unit-tested with 100% coverage (table-driven), and reused by both
 * the self (`/me`) and public API presenters.
 */

export type CertOrg = 'csia' | 'casi';
export type CertTrack = 'regular' | 'park' | 'carving';
export type TrainerDiscipline = 'ski' | 'snowboard';

export interface CertificationLike {
  org: CertOrg;
  track: CertTrack;
  level: number;
  isPartial?: boolean;
}

export interface TrainerStatusLike {
  org?: CertOrg;
  discipline: TrainerDiscipline;
  trainerLevel?: number | null;
}

const ORG_LABEL: Record<CertOrg, string> = {
  csia: 'CSIA',
  casi: 'CASI',
};

/**
 * Map a trainer discipline to its governing body. Ski ⇒ CSIA, snowboard ⇒ CASI.
 * Trainer rows don't carry `org` directly (CERTIFICATION_STRUCTURE.md keys them
 * by discipline), so we derive the label from the discipline.
 */
const DISCIPLINE_ORG: Record<TrainerDiscipline, CertOrg> = {
  ski: 'csia',
  snowboard: 'casi',
};

/**
 * Format a single certification row into its public display string.
 *
 * Examples (see CERTIFICATION_STRUCTURE.md § Display strings):
 *   CSIA Regular L3 full         → "CSIA Level 3"
 *   CSIA Regular L3 partial      → "CSIA Level 3 Partial"
 *   CSIA Park L1                 → "CSIA Park Level 1"
 *   CASI Regular L4 partial      → "CASI Level 4 Partial"
 *   CASI Park L2                 → "CASI Park Level 2"
 *   CASI Carving L1              → "CASI Carving Level 1"
 */
export function formatCertification(cert: CertificationLike): string {
  const org = ORG_LABEL[cert.org];
  const trackWord =
    cert.track === 'park'
      ? 'Park '
      : cert.track === 'carving'
        ? 'Carving '
        : '';
  // Park & carving are never partial; only regular surfaces the suffix.
  const partial =
    cert.track === 'regular' && cert.isPartial === true ? ' Partial' : '';
  return `${org} ${trackWord}Level ${cert.level}${partial}`;
}

/**
 * Format a trainer-status row into its display string, or `null` when the
 * instructor is not officially a trainer for that discipline (no `trainerLevel`).
 *
 *   Trainer CSIA level 2 (ski)        → "CSIA Level 2 Trainer"
 *   Trainer CASI level 3 (snowboard)  → "CASI Level 3 Trainer"
 *   Not a trainer (trainerLevel null) → null (omitted)
 */
export function formatTrainerStatus(status: TrainerStatusLike): string | null {
  if (status.trainerLevel === null || status.trainerLevel === undefined) {
    return null;
  }
  const org = ORG_LABEL[status.org ?? DISCIPLINE_ORG[status.discipline]];
  return `${org} Level ${status.trainerLevel} Trainer`;
}
