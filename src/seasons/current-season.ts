export interface SeasonRange {
  key: string;
  starts_on: string;
  ends_on: string;
}

export function seasonContaining<T extends SeasonRange>(
  seasons: readonly T[],
  date: string,
): T | null {
  return seasons.find((s) => s.starts_on <= date && date <= s.ends_on) ?? null;
}

export function currentSeasonOn<T extends SeasonRange>(
  seasons: readonly T[],
  today: string,
): T | null {
  const containing = seasonContaining(seasons, today);
  if (containing) {
    return containing;
  }
  const byStart = [...seasons].sort((a, b) =>
    a.starts_on.localeCompare(b.starts_on),
  );
  return byStart.find((s) => s.starts_on > today) ?? byStart.at(-1) ?? null;
}
