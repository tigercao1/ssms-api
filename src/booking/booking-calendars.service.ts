import { Inject, Injectable } from '@nestjs/common';
import type { FreeBusyResult } from '../google/google.types';
import { GoogleCalendarClient } from '../google/google-calendar.client';
import { WRITABLE_ACCESS_ROLES } from '../google/google-connection.service';

export const BOOKING_CLOCK = Symbol('BOOKING_CLOCK');
export const CALENDAR_CACHE_TTL_MS = 60_000;
const MAX_FREEBUSY_CACHE_ENTRIES = 200;

export interface BookingClock {
  now(): number;
}

interface Cached<T> {
  expiresAt: number;
  value: Promise<T>;
}

@Injectable()
export class BookingCalendarsService {
  private writable?: Cached<Set<string>>;
  private readonly freeBusyCache = new Map<string, Cached<FreeBusyResult>>();

  constructor(
    private readonly google: GoogleCalendarClient,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
  ) {}

  isConnected(): Promise<boolean> {
    return this.google.isConnected();
  }

  writableCalendars(): Promise<Set<string>> {
    const now = this.clock.now();
    if (!this.writable || this.writable.expiresAt <= now) {
      const value = this.google
        .listCalendars()
        .then(
          (calendars) =>
            new Set(
              calendars
                .filter((c) => WRITABLE_ACCESS_ROLES.has(c.accessRole))
                .map((c) => c.id),
            ),
        );
      const entry = { expiresAt: now + CALENDAR_CACHE_TTL_MS, value };
      this.writable = entry;
      value.catch(() => {
        if (this.writable === entry) {
          this.writable = undefined;
        }
      });
    }
    return this.writable.value;
  }

  cachedFreeBusy(
    calendarIds: string[],
    timeMin: string,
    timeMax: string,
  ): Promise<FreeBusyResult> {
    const now = this.clock.now();
    const key = `${[...new Set(calendarIds)].sort().join(',')}|${timeMin}|${timeMax}`;
    const hit = this.freeBusyCache.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.value;
    }
    this.prune(now);
    const value = this.google.freeBusy(calendarIds, timeMin, timeMax);
    this.freeBusyCache.set(key, {
      expiresAt: now + CALENDAR_CACHE_TTL_MS,
      value,
    });
    value.catch(() => this.freeBusyCache.delete(key));
    return value;
  }

  freshFreeBusy(
    calendarIds: string[],
    timeMin: string,
    timeMax: string,
  ): Promise<FreeBusyResult> {
    return this.google.freeBusy(calendarIds, timeMin, timeMax);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.freeBusyCache) {
      if (entry.expiresAt <= now) {
        this.freeBusyCache.delete(key);
      }
    }
    while (this.freeBusyCache.size >= MAX_FREEBUSY_CACHE_ENTRIES) {
      const oldest = this.freeBusyCache.keys().next().value as string;
      this.freeBusyCache.delete(oldest);
    }
  }
}
