export interface LegalName {
  firstName: string | null;
  lastName: string | null;
}

export type NameMatch =
  | { status: 'pass'; rule: NameRule; detail: string }
  | { status: 'unsure'; rule: NameRule; detail: string }
  | { status: 'fail'; rule: NameRule; detail: string };

export type NameRule =
  | 'no_legal_name'
  | 'non_latin'
  | 'exact'
  | 'middle_name'
  | 'initial'
  | 'close_spelling'
  | 'different_first_name'
  | 'different_person';

const MAX_TYPO_DISTANCE = 2;
const MIN_LENGTH_FOR_TYPO = 6;

export function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s\-'’.,]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

const compact = (tokens: string[]) => tokens.join('');

export function matchLegalName(cardName: string, legal: LegalName): NameMatch {
  const first = nameTokens(legal.firstName ?? '');
  const last = nameTokens(legal.lastName ?? '');
  const profile = `${legal.firstName ?? ''} ${legal.lastName ?? ''}`.trim();
  if (first.length === 0 || last.length === 0) {
    return {
      status: 'unsure',
      rule: 'no_legal_name',
      detail: 'Profile has no legal first and last name to compare with',
    };
  }
  if (
    /[^\p{Script=Latin}\s\-'’.,]/u.test(
      cardName.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''),
    )
  ) {
    return {
      status: 'unsure',
      rule: 'non_latin',
      detail: `Card name "${cardName}" is not in Latin letters; compare with "${profile}" by eye`,
    };
  }
  const card = nameTokens(cardName);
  const both = [compact([...first, ...last]), compact([...last, ...first])];
  if (both.includes(compact(card))) {
    return {
      status: 'pass',
      rule: 'exact',
      detail: `"${cardName}" matches legal name "${profile}"`,
    };
  }

  const hasLast =
    last.every((t) => card.includes(t)) || card.includes(compact(last));
  const hasFirstGiven = card.includes(first[0]);
  if (hasLast && hasFirstGiven) {
    const extra = card.filter(
      (t) => !first.includes(t) && !last.includes(t) && t !== compact(last),
    );
    const missing = first.slice(1).filter((t) => !card.includes(t));
    return {
      status: 'pass',
      rule: 'middle_name',
      detail: `"${cardName}" matches legal name "${profile}" apart from a middle name (${[...extra, ...missing].join(', ')})`,
    };
  }

  if (hasLast) {
    const given = card.filter((t) => !last.includes(t));
    if (
      given.length > 0 &&
      given.every((t) => t.length === 1) &&
      given[0] === first[0][0]
    ) {
      return {
        status: 'unsure',
        rule: 'initial',
        detail: `Card shows an initial ("${cardName}"); legal name is "${profile}"`,
      };
    }
  }

  const distance = Math.min(...both.map((b) => levenshtein(b, compact(card))));
  if (
    distance <= MAX_TYPO_DISTANCE &&
    compact(card).length >= MIN_LENGTH_FOR_TYPO
  ) {
    return {
      status: 'unsure',
      rule: 'close_spelling',
      detail: `"${cardName}" is spelled ${distance === 1 ? 'one letter' : 'two letters'} different from legal name "${profile}"`,
    };
  }

  if (hasLast) {
    return {
      status: 'unsure',
      rule: 'different_first_name',
      detail: `Same last name, different first name: "${cardName}" vs legal name "${profile}" (an English or preferred name?)`,
    };
  }

  return {
    status: 'fail',
    rule: 'different_person',
    detail: `"${cardName}" does not match legal name "${profile}"`,
  };
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
