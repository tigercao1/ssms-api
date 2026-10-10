export interface SsmsInstructorName {
  id: string;
  displayNameEn: string | null;
  displayNameZh: string | null;
}

export interface LegacyEntryName {
  handle: string;
  name: string;
}

export interface PairProposal {
  instructorId: string;
  ssmsNameEn: string;
  ssmsNameZh: string;
  legacyHandle: string;
  legacyName: string;
  score: number;
}

const HAN = /\p{Script=Han}/u;
const TOKEN = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu;

export function normaliseName(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function nameTokens(value: string | null | undefined): string[] {
  return (value ?? '').normalize('NFKC').toLowerCase().match(TOKEN) ?? [];
}

function levenshtein(a: string[], b: string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function editSimilarity(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const longest = Math.max(left.length, right.length);
  if (longest === 0) {
    return 0;
  }
  return 1 - levenshtein(left, right) / longest;
}

function sharedCharSimilarity(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const remaining = [...right];
  let shared = 0;
  for (const ch of left) {
    const index = remaining.indexOf(ch);
    if (index >= 0) {
      shared++;
      remaining.splice(index, 1);
    }
  }
  return (2 * shared) / (left.length + right.length);
}

function tokenSimilarity(a: string, b: string): number {
  if (HAN.test(a) && HAN.test(b)) {
    return Math.max(editSimilarity(a, b), sharedCharSimilarity(a, b));
  }
  return editSimilarity(a, b);
}

function tokenScore(legacy: string[], ssms: string[]): number {
  if (legacy.length === 0 || ssms.length === 0) {
    return 0;
  }
  const total = legacy.reduce(
    (sum, l) => sum + Math.max(...ssms.map((s) => tokenSimilarity(l, s))),
    0,
  );
  return total / legacy.length;
}

export function scoreNames(
  legacyName: string,
  ssmsEn: string | null | undefined,
  ssmsZh: string | null | undefined,
): number {
  const legacy = normaliseName(legacyName);
  if (legacy === '') {
    return 0;
  }
  const fullNames = [normaliseName(ssmsEn), normaliseName(ssmsZh)].filter(
    (n) => n !== '',
  );
  if (fullNames.length === 0) {
    return 0;
  }
  if (fullNames.includes(legacy)) {
    return 1;
  }
  const whole = Math.max(...fullNames.map((n) => editSimilarity(legacy, n)));
  const legacyTokens = nameTokens(legacyName);
  const ssmsTokens = [...nameTokens(ssmsEn), ...nameTokens(ssmsZh)];
  const byTokens = tokenScore(legacyTokens, ssmsTokens);
  const reverse = tokenScore(ssmsTokens, legacyTokens);
  const combined = Math.max(whole, (byTokens + reverse) / 2);
  return Math.round(Math.min(combined, 0.99) * 100) / 100;
}

export function proposePairs(
  instructors: SsmsInstructorName[],
  legacy: LegacyEntryName[],
  options: { minScore?: number; perInstructor?: number } = {},
): PairProposal[] {
  const minScore = options.minScore ?? 0.3;
  const perInstructor = options.perInstructor ?? 3;
  const rows: PairProposal[] = [];
  for (const instructor of instructors) {
    const base = {
      instructorId: instructor.id,
      ssmsNameEn: instructor.displayNameEn ?? '',
      ssmsNameZh: instructor.displayNameZh ?? '',
    };
    const candidates = legacy
      .map((entry) => ({
        entry,
        score: scoreNames(
          entry.name,
          instructor.displayNameEn,
          instructor.displayNameZh,
        ),
      }))
      .filter((c) => c.score >= minScore)
      .sort(
        (a, b) =>
          b.score - a.score || a.entry.handle.localeCompare(b.entry.handle),
      )
      .slice(0, perInstructor);
    if (candidates.length === 0) {
      rows.push({ ...base, legacyHandle: '', legacyName: '', score: 0 });
      continue;
    }
    for (const { entry, score } of candidates) {
      rows.push({
        ...base,
        legacyHandle: entry.handle,
        legacyName: entry.name,
        score,
      });
    }
  }
  return rows;
}
