import { zonedInstant } from '../booking/booking-time';

export interface JotformAnswer {
  answer?: unknown;
  prettyFormat?: unknown;
}

/** One submission as `GET https://api.jotform.com/form/{id}/submissions` returns it. */
export interface JotformSubmission {
  id: string;
  form_id: string;
  ip?: string | null;
  created_at: string;
  answers?: Record<string, JotformAnswer>;
}

type AnswerField =
  | 'participantName'
  | 'email'
  | 'typedDate'
  | 'idNumber'
  | 'guardianName'
  | 'witnessName';

/** Multipart fields for `POST /admin/signatures/jotform`. */
export type JotformImportFields = Record<
  'submissionId' | 'formId' | 'submittedAt' | 'email' | 'participantName',
  string
> &
  Partial<Record<'ip' | AnswerField, string>>;

export type MappedSubmission =
  | { ok: true; fields: JotformImportFields }
  | { ok: false; reason: string };

const ZH_FORM_ID = '242658653833264';
const EN_FORM_ID = '232628492941059';

export const JOTFORM_QUESTION_IDS: Record<
  string,
  Record<AnswerField, string>
> = {
  [ZH_FORM_ID]: {
    typedDate: '8',
    idNumber: '9',
    participantName: '12',
    guardianName: '13',
    email: '16',
    witnessName: '20',
  },
  [EN_FORM_ID]: {
    typedDate: '8',
    idNumber: '9',
    participantName: '12',
    guardianName: '13',
    email: '16',
    witnessName: '17',
  },
};

const OPTIONAL_FIELDS = [
  'typedDate',
  'idNumber',
  'guardianName',
  'witnessName',
] as const;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SUBMITTED_AT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):(\d{2})$/;

function text(
  answer: JotformAnswer | undefined,
  pretty = false,
): string | undefined {
  const value = pretty ? answer?.prettyFormat : answer?.answer;
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Jotform's `created_at` is wall-clock time in the account's zone, America/Toronto. */
export function jotformSubmittedAt(createdAt: string): string | null {
  const match = SUBMITTED_AT.exec(createdAt.trim());
  if (!match) {
    return null;
  }
  const [, date, time, seconds] = match;
  return new Date(
    zonedInstant(date, time).getTime() + Number(seconds) * 1000,
  ).toISOString();
}

export function mapJotformSubmission(
  submission: JotformSubmission,
): MappedSubmission {
  const questions = JOTFORM_QUESTION_IDS[submission.form_id];
  if (!questions) {
    return { ok: false, reason: `unknown form ${submission.form_id}` };
  }
  const submittedAt = jotformSubmittedAt(submission.created_at);
  if (!submittedAt) {
    return {
      ok: false,
      reason: `unreadable submit time ${submission.created_at}`,
    };
  }
  const answers = submission.answers ?? {};
  const answer = (field: AnswerField) =>
    text(answers[questions[field]], field === 'typedDate');
  const email = answer('email')?.toLowerCase();
  if (!email || !EMAIL.test(email)) {
    return { ok: false, reason: 'no usable email' };
  }
  const participantName = answer('participantName');
  if (!participantName) {
    return { ok: false, reason: 'no participant name' };
  }
  const optional: Partial<Record<AnswerField, string>> = {};
  for (const field of OPTIONAL_FIELDS) {
    const value = answer(field);
    if (value) {
      optional[field] = value;
    }
  }
  const ip = submission.ip?.trim();
  return {
    ok: true,
    fields: {
      submissionId: submission.id,
      formId: submission.form_id,
      submittedAt,
      email,
      participantName,
      ...(ip ? { ip } : {}),
      ...optional,
    },
  };
}

function csvCell(value: string | null | undefined): string {
  const cell = value ?? '';
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function toCsv(
  header: readonly string[],
  rows: readonly Record<string, string | null | undefined>[],
): string {
  return [
    header.join(','),
    ...rows.map((row) => header.map((name) => csvCell(row[name])).join(',')),
  ]
    .join('\n')
    .concat('\n');
}
