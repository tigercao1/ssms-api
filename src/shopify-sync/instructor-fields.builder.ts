import {
  type CertOrg,
  formatCertification,
  type TrainerDiscipline,
} from '../instructors/cert-display.formatter';
import type {
  InstructorSnapshot,
  ShopifyFieldInput,
  SyncCertRow,
  SyncRefName,
  SyncTrainerRow,
} from './instructor-sync.types';

export interface BuildFieldsOptions {
  existingEntry: boolean;
  picture?: string | null;
  image_1?: string | null;
  image_2?: string | null;
}

export interface EnglishTranslations {
  name: string | null;
  introduction: string | null;
  client_groups: string | null;
  locations: string | null;
  languages: string | null;
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
    ['client_groups', clientGroups(snapshot, zhName, '，')],
    ['locations', jsonList(snapshot.locations.map(zhName))],
    ['languages', jsonList(snapshot.languages.map(zhName))],
    [
      'min_age',
      instructor.min_student_age == null
        ? ''
        : String(instructor.min_student_age),
    ],
    ['ssms_id', instructor.id],
    ['picture', fileReference(options.picture)],
    ['image_1', fileReference(options.image_1)],
    ['image_2', fileReference(options.image_2)],
  ];
  return candidates
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (entry[1] !== '' || options.existingEntry),
    )
    .map(([key, value]) => ({ key, value }));
}

export function englishTranslations(
  snapshot: InstructorSnapshot,
): EnglishTranslations {
  const { instructor } = snapshot;
  return {
    name: englishOverChinese(
      instructor.display_name_en,
      instructor.display_name_zh,
    ),
    introduction: englishOverChinese(instructor.bio_en, instructor.bio_zh),
    client_groups: englishWhereDifferent(
      clientGroups(snapshot, enName, ', '),
      clientGroups(snapshot, zhName, '，'),
    ),
    locations: englishWhereDifferent(
      jsonList(snapshot.locations.map(enName)),
      jsonList(snapshot.locations.map(zhName)),
    ),
    languages: englishWhereDifferent(
      jsonList(snapshot.languages.map(enName)),
      jsonList(snapshot.languages.map(zhName)),
    ),
  };
}

function fileReference(fileId: string | null | undefined): string | undefined {
  return fileId === undefined ? undefined : (fileId ?? '');
}

function zhName(ref: SyncRefName): string {
  return nonBlank(ref.name_zh) ?? ref.name;
}

function enName(ref: SyncRefName): string {
  return ref.name;
}

function clientGroups(
  snapshot: InstructorSnapshot,
  label: (ref: SyncRefName) => string,
  separator: string,
): string {
  return [...snapshot.courseLevels, ...snapshot.examPreparations]
    .map(label)
    .join(separator);
}

function englishWhereDifferent(en: string, zh: string): string | null {
  return en === '' || en === zh ? null : en;
}

function englishOverChinese(
  en: string | null,
  zh: string | null,
): string | null {
  return nonBlank(zh) === null ? null : nonBlank(en);
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
