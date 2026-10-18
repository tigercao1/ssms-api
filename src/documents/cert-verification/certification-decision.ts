import type { CertOrg, CertTrack } from '../documents.types';
import {
  ACCEPTED_DOCUMENT_TYPES,
  CERT_POLICY_VERSION,
  type CertDocumentType,
  MIN_FIELD_CONFIDENCE,
  MIN_NAME_SIMILARITY,
} from './certification-policy';

export interface CertificationExtraction {
  documentType: CertDocumentType;
  issuer: string | null;
  holderName: string | null;
  org: CertOrg | null;
  track: CertTrack | null;
  level: number | null;
  isPartial: boolean | null;
  validThrough: string | null;
  memberNumber: string | null;
  legible: boolean;
  tamperSigns: string[];
  confidence: Record<
    'holderName' | 'org' | 'track' | 'level' | 'validThrough',
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
}

export type CheckId =
  | 'document_type'
  | 'legible'
  | 'no_tamper_signs'
  | 'holder_name'
  | 'org'
  | 'track'
  | 'level'
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

  const field = <T>(
    id: CheckId,
    read: T | null,
    want: T,
    conf: number,
    label: string,
  ) => {
    if (read === null) {
      add(id, 'unsure', `No ${label} found`);
    } else if (!confident(conf)) {
      add(id, 'unsure', `${label} read as ${String(read)} with low confidence`);
    } else {
      add(
        id,
        read === want ? 'pass' : 'fail',
        `${label} ${String(read)}, profile says ${String(want)}`,
      );
    }
  };
  field('org', x.org, declared.org, x.confidence.org, 'Organization');
  field('track', x.track, declared.track, x.confidence.track, 'Track');

  if (x.level === null) {
    add('level', 'unsure', 'No level found');
  } else if (!confident(x.confidence.level)) {
    add('level', 'unsure', `Level read as ${x.level} with low confidence`);
  } else if (x.level < declared.level) {
    add(
      'level',
      'fail',
      `Document shows level ${x.level}, profile claims ${declared.level}`,
    );
  } else if (x.level > declared.level) {
    add(
      'level',
      'unsure',
      `Document shows level ${x.level}, higher than profile level ${declared.level}`,
    );
  } else if ((x.isPartial ?? false) !== declared.isPartial) {
    add('level', 'unsure', `Partial status differs from profile`);
  } else {
    add('level', 'pass', `Level ${x.level}`);
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
