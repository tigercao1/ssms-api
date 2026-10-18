import type { CertOrg, CertTrack } from '../documents.types';
import {
  ACCEPTED_DOCUMENT_TYPES,
  CERT_POLICY_VERSION,
  type CertDocumentType,
  MIN_FIELD_CONFIDENCE,
  MEMBER_NUMBER_FORMAT,
  MIN_NAME_SIMILARITY,
} from './certification-policy';

export interface ExtractedCertification {
  text: string;
  track: CertTrack | null;
  level: number | null;
  isPartial: boolean;
  confidence: number;
}

export interface CertificationExtraction {
  documentType: CertDocumentType;
  issuer: string | null;
  org: CertOrg | null;
  holderName: string | null;
  memberNumber: string | null;
  membershipCategory: string | null;
  membershipSeason: string | null;
  certifications: ExtractedCertification[];
  validThrough: string | null;
  recallYear: number | null;
  legible: boolean;
  tamperSigns: string[];
  confidence: Record<
    'holderName' | 'org' | 'memberNumber' | 'validThrough',
    number
  >;
  notes: string;
}

export interface DeclaredCertification {
  names: string[];
  org: CertOrg;
  track: CertTrack;
  level: number;
  isPartial: boolean;
  validUntil: string;
  /** Member number the instructor typed at upload, if the form asks for it. */
  memberNumber?: string | null;
  /** Member numbers on this instructor's earlier approved uploads for the same org. */
  previousMemberNumbers?: string[];
  /** Whether another instructor already has an approved upload with this org and member number. */
  memberNumberUsedByOthers?: boolean;
}

export type CheckId =
  | 'document_type'
  | 'legible'
  | 'no_tamper_signs'
  | 'holder_name'
  | 'org'
  | 'track'
  | 'level'
  | 'member_number'
  | 'valid_through_present'
  | 'valid_through_matches'
  | 'not_expired';

export type CheckStatus = 'pass' | 'fail' | 'unsure';

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  detail: string;
}

export type Verdict = 'verified' | 'needs_review' | 'likely_invalid';

export interface CertificationDecision {
  policyVersion: string;
  verdict: Verdict;
  checks: CheckResult[];
  suggestedValidUntil: string | null;
}

const HARD_FAILS: readonly CheckId[] = [
  'document_type',
  'org',
  'track',
  'level',
  'not_expired',
  'holder_name',
  'member_number',
];

export function normalizeName(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

export function nameSimilarity(a: string, b: string): number {
  const ta = normalizeName(a);
  const tb = normalizeName(b);
  if (ta.length === 0 || tb.length === 0) {
    return 0;
  }
  const joinedA = ta.join('');
  const joinedB = tb.join('');
  if (joinedA === joinedB) {
    return 1;
  }
  const distance = levenshtein(joinedA, joinedB);
  return 1 - distance / Math.max(joinedA.length, joinedB.length);
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = temp;
    }
  }
  return prev[b.length];
}

function confident(value: number): boolean {
  return value >= MIN_FIELD_CONFIDENCE;
}

export function decide(
  extraction: CertificationExtraction,
  declared: DeclaredCertification,
  today: string,
): CertificationDecision {
  const x = extraction;
  const checks: CheckResult[] = [];
  const add = (id: CheckId, status: CheckStatus, detail: string) =>
    checks.push({ id, status, detail });

  add(
    'document_type',
    ACCEPTED_DOCUMENT_TYPES.includes(x.documentType) ? 'pass' : 'fail',
    `Document read as ${x.documentType}`,
  );
  add(
    'legible',
    x.legible ? 'pass' : 'unsure',
    x.legible ? 'Readable' : 'Parts are not readable',
  );
  add(
    'no_tamper_signs',
    x.tamperSigns.length === 0 ? 'pass' : 'unsure',
    x.tamperSigns.length === 0 ? 'None seen' : x.tamperSigns.join('; '),
  );

  if (x.holderName === null) {
    add('holder_name', 'unsure', 'No name found on the document');
  } else {
    const best = Math.max(
      0,
      ...declared.names.map((n) => nameSimilarity(n, x.holderName!)),
    );
    const status: CheckStatus =
      best >= MIN_NAME_SIMILARITY && confident(x.confidence.holderName)
        ? 'pass'
        : best < 0.5 && confident(x.confidence.holderName)
          ? 'fail'
          : 'unsure';
    add(
      'holder_name',
      status,
      `"${x.holderName}" vs profile, similarity ${best.toFixed(2)}`,
    );
  }

  if (x.org === null) {
    add('org', 'unsure', 'No issuer found');
  } else if (!confident(x.confidence.org)) {
    add('org', 'unsure', `Issuer read as ${x.org} with low confidence`);
  } else {
    add(
      'org',
      x.org === declared.org ? 'pass' : 'fail',
      `Card issued by ${x.org.toUpperCase()}, profile says ${declared.org.toUpperCase()}`,
    );
  }

  const lines = x.certifications.filter((c) => c.track === declared.track);
  const line = lines.sort((p, q) => (q.level ?? 0) - (p.level ?? 0))[0];
  const printed = x.certifications.map((c) => c.text).join('; ') || 'none';
  if (!line) {
    const status: CheckStatus =
      x.certifications.length > 0 &&
      x.certifications.every((c) => c.track !== null && confident(c.confidence))
        ? 'fail'
        : 'unsure';
    add(
      'track',
      status,
      `No ${declared.track} certification on the card (printed: ${printed})`,
    );
  } else if (!confident(line.confidence) || line.level === null) {
    add('track', 'pass', `"${line.text}"`);
    add('level', 'unsure', `"${line.text}" read with low confidence`);
  } else {
    add('track', 'pass', `"${line.text}"`);
    if (line.level < declared.level) {
      add(
        'level',
        'fail',
        `Card shows level ${line.level}, profile claims ${declared.level}`,
      );
    } else if (line.level > declared.level) {
      add(
        'level',
        'unsure',
        `Card shows level ${line.level}, higher than profile level ${declared.level}`,
      );
    } else if (line.isPartial !== declared.isPartial) {
      add('level', 'unsure', 'Partial status differs from profile');
    } else {
      add('level', 'pass', `Level ${line.level}`);
    }
  }

  const number = x.memberNumber?.replace(/\s+/g, '') ?? null;
  if (number === null) {
    add('member_number', 'unsure', 'No member number found');
  } else if (!confident(x.confidence.memberNumber)) {
    add(
      'member_number',
      'unsure',
      `Member number read as ${number} with low confidence`,
    );
  } else if (!MEMBER_NUMBER_FORMAT[declared.org].test(number)) {
    add(
      'member_number',
      'unsure',
      `Member number ${number} does not look like a ${declared.org.toUpperCase()} number`,
    );
  } else if (declared.memberNumberUsedByOthers) {
    add(
      'member_number',
      'fail',
      `Member number ${number} is already on another instructor's approved card`,
    );
  } else if (
    declared.memberNumber &&
    declared.memberNumber.replace(/\s+/g, '') !== number
  ) {
    add(
      'member_number',
      'fail',
      `Card shows ${number}, instructor entered ${declared.memberNumber}`,
    );
  } else if (
    declared.previousMemberNumbers?.length &&
    !declared.previousMemberNumbers.includes(number)
  ) {
    add(
      'member_number',
      'unsure',
      `Card shows ${number}, earlier approved card had ${declared.previousMemberNumbers.join(', ')}`,
    );
  } else {
    add('member_number', 'pass', `Member number ${number}`);
  }

  let suggestedValidUntil: string | null = null;
  if (x.validThrough === null || !/^\d{4}-\d{2}-\d{2}$/.test(x.validThrough)) {
    add('valid_through_present', 'unsure', 'No valid-through date found');
  } else if (!confident(x.confidence.validThrough)) {
    add(
      'valid_through_present',
      'unsure',
      `Date read as ${x.validThrough} with low confidence`,
    );
  } else {
    add('valid_through_present', 'pass', x.validThrough);
    add(
      'not_expired',
      x.validThrough >= today ? 'pass' : 'fail',
      x.validThrough >= today
        ? `Valid through ${x.validThrough}`
        : `Expired on ${x.validThrough}`,
    );
    if (x.validThrough === declared.validUntil) {
      add(
        'valid_through_matches',
        'pass',
        'Matches the date the instructor entered',
      );
    } else {
      add(
        'valid_through_matches',
        'unsure',
        `Document says ${x.validThrough}, instructor entered ${declared.validUntil}`,
      );
      suggestedValidUntil = x.validThrough;
    }
  }

  const hardFail = checks.some(
    (c) => c.status === 'fail' && HARD_FAILS.includes(c.id),
  );
  const allPass =
    checks.every((c) => c.status === 'pass') &&
    checks.some((c) => c.id === 'valid_through_matches');
  return {
    policyVersion: CERT_POLICY_VERSION,
    verdict: hardFail
      ? 'likely_invalid'
      : allPass
        ? 'verified'
        : 'needs_review',
    checks,
    suggestedValidUntil,
  };
}
