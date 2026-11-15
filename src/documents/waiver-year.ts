import { torontoToday } from './certification-validity';

export const WAIVER_YEAR_START_MONTH = 7;
export const WAIVER_YEAR_START_DAY = 1;

export type WaiverStatus = 'signed' | 'expired' | 'none';

export interface Waiver {
  status: WaiverStatus;
  signedAt: string | null;
  year: string;
}

export function waiverYearStart(at: Date): number {
  const [year, month, day] = torontoToday(at).split('-').map(Number);
  const started =
    month > WAIVER_YEAR_START_MONTH ||
    (month === WAIVER_YEAR_START_MONTH && day >= WAIVER_YEAR_START_DAY);
  return started ? year : year - 1;
}

export function waiverYearKey(at: Date = new Date()): string {
  const start = waiverYearStart(at);
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}

export function signedThisWaiverYear(
  signedAt: string,
  now: Date = new Date(),
): boolean {
  return waiverYearStart(new Date(signedAt)) >= waiverYearStart(now);
}

export function waiverFor(
  latestSignedAt: string | null,
  now: Date = new Date(),
): Waiver {
  const year = waiverYearKey(now);
  if (!latestSignedAt) {
    return { status: 'none', signedAt: null, year };
  }
  return {
    status: signedThisWaiverYear(latestSignedAt, now) ? 'signed' : 'expired',
    signedAt: latestSignedAt,
    year,
  };
}
