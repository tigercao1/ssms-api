import {
  type CertOrg,
  type CertTrack,
  formatCertification,
  formatTrainerStatus,
  type TrainerDiscipline,
} from '../instructors/cert-display.formatter';
import type { InstructorSummary } from '../shopify-sync/go-live.service';
import type { AdminInstructorRow } from './admin.types';

export const CSV_BOM = '\uFEFF';

export const MSL_LOCATION_KEY = 'teaching_location.moonstone';

export const INSTRUCTOR_EXPORT_COLUMNS = [
  'Name',
  'Email',
  'Phone',
  'Date of Birth',
  'Certifications',
  'MSLM Podium Pass Holder',
];

export interface InstructorExportRow {
  name: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  certifications: string;
  mslPassHolder: boolean;
}

const CERTIFICATION_GROUPS: { org: CertOrg; discipline: TrainerDiscipline }[] =
  [
    { org: 'csia', discipline: 'ski' },
    { org: 'casi', discipline: 'snowboard' },
  ];
const TRACK_ORDER: CertTrack[] = ['regular', 'park', 'carving'];

function textCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function exportName(
  row: Pick<AdminInstructorRow, 'display_name_en' | 'first_name' | 'last_name'>,
): string {
  const legalName = [row.first_name, row.last_name]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(' ');
  return legalName || row.display_name_en.trim();
}

export function hasNonAscii(value: string): boolean {
  return /\P{ASCII}/u.test(value);
}

function certificationText({
  certifications,
  trainers,
}: Pick<InstructorSummary, 'certifications' | 'trainers'>): string {
  return CERTIFICATION_GROUPS.flatMap(({ org, discipline }) => [
    ...TRACK_ORDER.flatMap((track) =>
      certifications
        .filter((cert) => cert.org === org && cert.track === track)
        .map((cert) =>
          formatCertification({
            org,
            track,
            level: cert.level,
            isPartial: cert.is_partial,
          }),
        ),
    ),
    ...trainers
      .filter((trainer) => trainer.discipline === discipline)
      .map((trainer) =>
        formatTrainerStatus({
          discipline,
          trainerLevel: trainer.trainer_level,
        }),
      )
      .filter((text): text is string => text !== null),
  ]).join('; ');
}

export function instructorExportRow(
  row: AdminInstructorRow,
  summary: Pick<InstructorSummary, 'certifications' | 'trainers'> | undefined,
  mslPassHolder: boolean,
): InstructorExportRow {
  return {
    name: exportName(row),
    email: row.email,
    phone: '',
    dateOfBirth: row.date_of_birth ?? '',
    certifications: certificationText(
      summary ?? { certifications: [], trainers: [] },
    ),
    mslPassHolder,
  };
}

export function instructorExportCsv(rows: InstructorExportRow[]): string {
  const lines = [
    INSTRUCTOR_EXPORT_COLUMNS,
    ...rows.map((row) => [
      row.name,
      row.email,
      row.phone,
      row.dateOfBirth,
      row.certifications,
      row.mslPassHolder ? 'TRUE' : 'FALSE',
    ]),
  ].map((cells) => cells.map((cell) => quote(textCell(cell))).join(','));
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}
