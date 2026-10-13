import { Logger } from '@nestjs/common';
import {
  AMY_CAL,
  fakeBookingGoogle,
  InMemoryBookingRepository,
} from '../../test/helpers/booking-fakes';
import { DatabaseError } from '../database/db-result';
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleNotConnectedError,
} from '../google/google.errors';
import {
  CalendarSyncService,
  classEventId,
  syncErrorCode,
} from './calendar-sync.service';

const CLASS_ID = 'c0000000-0000-4000-8000-000000000001';

function build() {
  const repo = new InMemoryBookingRepository();
  const google = fakeBookingGoogle();
  const sync = new CalendarSyncService(repo, google.client, {
    now: () => Date.parse('2026-12-10T17:00:00.000Z'),
  });
  repo.add({
    id: CLASS_ID,
    starts_at: '2026-12-12T15:00:00.000Z',
    ends_at: '2026-12-12T16:00:00.000Z',
    google_calendar_id: AMY_CAL,
    google_sync_status: 'pending',
  });
  return { repo, google, sync };
}

describe('CalendarSyncService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('derives a Google-safe event id from the class id', () => {
    const id = classEventId('C0000000-0000-4000-8000-000000000001', 2);
    expect(id).toBe('ssmsc00000000000400080000000000000012');
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
  });

  it.each([
    [new GoogleNotConnectedError(), 'not_connected'],
    [new GoogleApiError(undefined, undefined, 'reset'), 'network'],
    [new GoogleApiError(500, undefined, 'boom'), '500'],
    [new GoogleApiError(403, 'forbidden', 'no'), '403:forbidden'],
    [new GoogleAuthError(400, 'invalid_client', ''), 'auth:invalid_client'],
    [new Error('other'), 'internal'],
  ])('maps %p to the stored error code %p', (err, code) => {
    expect(syncErrorCode(err)).toBe(code);
  });

  it('reports a failure when the result cannot be saved, and leaves the class pending', async () => {
    const { repo, sync } = build();
    repo.failNext = new DatabaseError('finish calendar sync', '08006', 'gone');
    await expect(sync.syncClass(CLASS_ID)).resolves.toEqual({
      calendarSync: 'failed',
      error: 'internal',
    });
    expect(repo.classes[0].google_sync_status).toBe('pending');
  });

  it('counts a deletion lookup failure as a failed sync', async () => {
    const { repo, sync } = build();
    jest.spyOn(repo, 'classDeletions').mockRejectedValueOnce(new Error('db'));
    await expect(sync.syncClass(CLASS_ID)).resolves.toEqual({
      calendarSync: 'failed',
      error: 'internal',
    });
    expect(repo.classes[0].google_sync_status).toBe('failed');
  });

  it('still reports the deletion error when recording it fails', async () => {
    const { repo, google, sync } = build();
    repo.queueDeletion(AMY_CAL, 'old', CLASS_ID);
    google.deleteEvent.mockRejectedValueOnce('down');
    jest.spyOn(repo, 'failDeletion').mockRejectedValueOnce(new Error('db'));
    await expect(sync.syncClass(CLASS_ID)).resolves.toEqual({
      calendarSync: 'failed',
      error: 'internal',
    });
  });

  it('skips classes it cannot load', async () => {
    const { repo, google, sync } = build();
    jest.spyOn(repo, 'findClasses').mockRejectedValueOnce(new Error('db'));
    await sync.syncPending([CLASS_ID]);
    await expect(sync.syncClass('missing')).resolves.toBeNull();
    expect(google.insertEvent).not.toHaveBeenCalled();
  });
});
