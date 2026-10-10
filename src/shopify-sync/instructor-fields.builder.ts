import {
  type CertOrg,
  formatCertification,
  type TrainerDiscipline,
} from '../instructors/cert-display.formatter';
import type {
  InstructorSnapshot,
  ShopifyFieldInput,
  SyncCertRow,
  SyncTrainerRow,
} from './instructor-sync.types';

export interface BuildFieldsOptions {
  existingEntry: boolean;
  picture?: string | null;
}

const DISCIPLINES: {
  discipline: TrainerDiscipline;
  org: CertOrg;
  typeLabel: string;
  trainerLabel: string;
}[] = [
  { discipline: 'ski', org: 'csia', typeLabel: '双板', trainerLabel: 'Ski' },
  {
    discipline: 'snowboard',
    org: 'casi',
    typeLabel: '单板',
    trainerLabel: 'Snowboard',
  },
];

const TRACK_PRECEDENCE: Record<SyncCertRow['track'], number> = {
  regular: 0,
  park: 1,
  carving: 2,
};

export function buildInstructorFields(
  snapshot: InstructorSnapshot,
  options: BuildFieldsOptions,
): ShopifyFieldInput[] {
  const { instructor } = snapshot;
  const candidates: [string, string | undefined][] = [
    ['name', baseText(instructor.display_name_zh, instructor.display_name_en)],
    ['introduction', baseText(instructor.bio_zh, instructor.bio_en)],
    ['type', disciplineType(snapshot)],
    ['certification', certificationLine(snapshot)],
    [
      'client_groups',
      [...snapshot.courseLevels, ...snapshot.examPreparations].join('，'),
    ],
    ['locations', jsonList(snapshot.locations)],
    ['languages', jsonList(snapshot.languages)],
    [
      'min_age',
      instructor.min_student_age == null
        ? ''
        : String(instructor.min_student_age),
    ],
    ['ssms_id', instructor.id],
    [
      'picture',
      options.picture === undefined ? undefined : (options.picture ?? ''),
    ],
  ];
  return candidates
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (entry[1] !== '' || options.existingEntry),
    )
    .map(([key, value]) => ({ key, value }));
}

function baseText(zh: string | null, en: string | null): string {
  return nonBlank(zh) ?? nonBlank(en) ?? '';
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function jsonList(values: string[]): string {
  return values.length === 0 ? '' : JSON.stringify(values);
}

function heldDisciplines(snapshot: InstructorSnapshot) {
  return DISCIPLINES.filter(
    ({ discipline, org }) =>
      snapshot.certifications.some((c) => c.org === org) ||
      trainerLevel(snapshot.trainers, discipline) !== null,
  );
}

function disciplineType(snapshot: InstructorSnapshot): string {
  return heldDisciplines(snapshot)
    .map((d) => d.typeLabel)
    .join(' | ');
}

function certificationLine(snapshot: InstructorSnapshot): string {
  const parts: string[] = [];
  for (const { discipline, org, trainerLabel } of heldDisciplines(snapshot)) {
    const cert = highestCertification(
      snapshot.certifications.filter((c) => c.org === org),
    );
    if (cert) {
      parts.push(
        formatCertification({
          org: cert.org,
          track: cert.track,
          level: cert.level,
          isPartial: cert.is_partial,
        }),
      );
    }
    const level = trainerLevel(snapshot.trainers, discipline);
    if (level !== null) {
      parts.push(`${trainerLabel} Trainer Level ${level}`);
    }
  }
  return parts.join(', ');
}

function highestCertification(certs: SyncCertRow[]): SyncCertRow | undefined {
  const regular = certs.filter((c) => c.track === 'regular');
  const pool = regular.length > 0 ? regular : certs;
  return [...pool].sort(
    (a, b) =>
      b.level - a.level ||
      TRACK_PRECEDENCE[a.track] - TRACK_PRECEDENCE[b.track],
  )[0];
}

function trainerLevel(
  trainers: SyncTrainerRow[],
  discipline: TrainerDiscipline,
): number | null {
  const levels = trainers
    .filter((t) => t.discipline === discipline && t.trainer_level != null)
    .map((t) => t.trainer_level as number);
  return levels.length === 0 ? null : Math.max(...levels);
}
