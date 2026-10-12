export type CalendarMatchKind = 'email' | 'name';

export interface MatchableInstructor {
  id: string;
  email: string | null;
  displayNameEn: string;
  displayNameZh: string | null;
}

export interface MatchableCalendar {
  id: string;
  summary: string;
}

export interface CalendarCandidate {
  calendarId: string;
  calendarSummary: string;
  matchedBy: CalendarMatchKind;
}

export interface CalendarProposal {
  candidates: CalendarCandidate[];
  suggestion: CalendarCandidate | null;
}

const MIN_NAME_KEY_LENGTH = 2;

export function nameKey(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function emailKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function calendarNameKeys(calendar: MatchableCalendar): Set<string> {
  const localPart = calendar.id.includes('@')
    ? calendar.id.slice(0, calendar.id.indexOf('@'))
    : '';
  return new Set(
    [nameKey(calendar.summary), nameKey(localPart)].filter(
      (key) => key.length >= MIN_NAME_KEY_LENGTH,
    ),
  );
}

function instructorNameKeys(instructor: MatchableInstructor): string[] {
  return [nameKey(instructor.displayNameEn), nameKey(instructor.displayNameZh)]
    .filter((key) => key.length >= MIN_NAME_KEY_LENGTH)
    .filter((key, index, keys) => keys.indexOf(key) === index);
}

function candidateFor(
  instructor: MatchableInstructor,
  calendar: MatchableCalendar,
): CalendarCandidate | null {
  const email = emailKey(instructor.email);
  const base = { calendarId: calendar.id, calendarSummary: calendar.summary };
  if (
    email &&
    (emailKey(calendar.id) === email || emailKey(calendar.summary) === email)
  ) {
    return { ...base, matchedBy: 'email' };
  }
  const keys = calendarNameKeys(calendar);
  if (instructorNameKeys(instructor).some((key) => keys.has(key))) {
    return { ...base, matchedBy: 'name' };
  }
  return null;
}

export function proposeCalendarMatches(
  instructors: MatchableInstructor[],
  calendars: MatchableCalendar[],
  linkedCalendarOwners: ReadonlyMap<string, string> = new Map(),
): Map<string, CalendarProposal> {
  const candidatesByInstructor = new Map<string, CalendarCandidate[]>();
  const claims = new Map<string, number>();
  for (const instructor of instructors) {
    const candidates = calendars
      .filter((calendar) => {
        const owner = linkedCalendarOwners.get(calendar.id);
        return owner === undefined || owner === instructor.id;
      })
      .map((calendar) => candidateFor(instructor, calendar))
      .filter((candidate): candidate is CalendarCandidate => candidate !== null)
      .sort((a, b) =>
        a.matchedBy === b.matchedBy ? 0 : a.matchedBy === 'email' ? -1 : 1,
      );
    for (const candidate of candidates) {
      claims.set(
        candidate.calendarId,
        (claims.get(candidate.calendarId) ?? 0) + 1,
      );
    }
    candidatesByInstructor.set(instructor.id, candidates);
  }

  const proposals = new Map<string, CalendarProposal>();
  for (const [instructorId, candidates] of candidatesByInstructor) {
    const byEmail = candidates.filter((c) => c.matchedBy === 'email');
    const byName = candidates.filter((c) => c.matchedBy === 'name');
    let suggestion: CalendarCandidate | null = null;
    if (byEmail.length === 1) {
      suggestion = byEmail[0];
    } else if (
      byEmail.length === 0 &&
      byName.length === 1 &&
      claims.get(byName[0].calendarId) === 1
    ) {
      suggestion = byName[0];
    }
    proposals.set(instructorId, { candidates, suggestion });
  }
  return proposals;
}
