import { Logger } from '@nestjs/common';
import {
  InMemoryCertificationUploadsRepository,
  recordingMailer,
} from '../../test/helpers/certification-fakes';
import {
  certificationUploadRow,
  InMemoryDocumentSubjectsRepository,
} from '../../test/helpers/documents-fakes';
import { CertificationExpiryService } from './certification-expiry.service';
import { addDays } from './certification-validity';
import type { CertificationUploadRow } from './documents.types';

const TODAY = '2026-10-12';
const NOW = new Date('2026-10-12T14:00:00.000Z');

function setup(outcome: 'sent' | 'failed' | 'skipped' = 'sent') {
  const subjects = new InMemoryDocumentSubjectsRepository();
  const uploads = new InMemoryCertificationUploadsRepository(subjects);
  const { mailer, sent, control } = recordingMailer(outcome);
  const service = new CertificationExpiryService(uploads, mailer);
  const instructor = subjects.seedInstructor({ display_name_en: 'Lin Wei' });
  subjects.certifications.set(instructor.id, [
    { org: 'csia', track: 'regular', level: 2 },
    { org: 'casi', track: 'park', level: 1 },
  ]);
  const seed = (overrides: Partial<CertificationUploadRow> = {}) => {
    const row = certificationUploadRow({
      instructor_id: instructor.id,
      ...overrides,
    });
    subjects.uploads.push(row);
    return row;
  };
  return { subjects, uploads, sent, control, service, instructor, seed };
}

describe('CertificationExpiryService.run', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends nothing when no upload is near expiry', async () => {
    const { service, seed, sent } = setup();
    seed({ valid_until: addDays(TODAY, 31) });
    seed({ track: 'park', org: 'casi', valid_until: addDays(TODAY, -8) });
    await expect(service.run(TODAY, NOW)).resolves.toEqual({
      expiring: 0,
      expired: 0,
      failed: 0,
    });
    expect(sent).toEqual([]);
  });

  it('emails an upload 30 days out once, with a re-upload link', async () => {
    const { service, seed, sent, instructor, subjects } = setup();
    const row = seed({ valid_until: addDays(TODAY, 30) });
    await expect(service.run(TODAY, NOW)).resolves.toEqual({
      expiring: 1,
      expired: 0,
      failed: 0,
    });
    expect(sent).toEqual([
      {
        template: 'certification.expiring',
        to: instructor.email,
        language: 'en',
        vars: {
          displayName: 'Lin Wei',
          org: 'csia',
          track: 'regular',
          level: 2,
          validUntil: row.valid_until,
          uploadUrl: 'https://portal.example.com/onboarding',
        },
        mode: 'background',
        instructorId: instructor.id,
        authUserId: instructor.auth_user_id,
        metadata: {
          certificationUploadId: row.id,
          certification: 'csia:regular',
          validUntil: row.valid_until,
        },
        idempotencyKey: `certification.expiring:${row.id}:${row.valid_until}`,
      },
    ]);
    expect(subjects.uploads[0].expiry_reminder_sent_at).toBe(NOW.toISOString());
    await service.run(TODAY, NOW);
    await service.run(addDays(TODAY, 10));
    expect(sent).toHaveLength(1);
  });

  it('then emails once on the day after expiry, and never again', async () => {
    const { service, seed, sent } = setup();
    seed({ valid_until: addDays(TODAY, 30) });
    await service.run(TODAY, NOW);
    const expiry = addDays(TODAY, 30);
    await service.run(expiry);
    expect(sent).toHaveLength(1);
    await expect(service.run(addDays(expiry, 1))).resolves.toEqual({
      expiring: 0,
      expired: 1,
      failed: 0,
    });
    expect(sent[1].template).toBe('certification.expired');
    for (let day = 2; day <= 10; day += 1) {
      await service.run(addDays(expiry, day));
    }
    expect(sent).toHaveLength(2);
  });

  it('catches up a missed expired email within the grace window only', async () => {
    const { service, seed, sent } = setup();
    seed({ valid_until: addDays(TODAY, -7) });
    seed({ org: 'casi', track: 'park', valid_until: addDays(TODAY, -8) });
    await expect(service.run(TODAY, NOW)).resolves.toMatchObject({
      expired: 1,
    });
    expect(sent.map((s) => s.metadata?.certification)).toEqual([
      'csia:regular',
    ]);
  });

  it('includes pending uploads and skips rejected ones', async () => {
    const { service, seed, sent } = setup();
    seed({ review_status: 'pending', valid_until: addDays(TODAY, 5) });
    seed({
      org: 'casi',
      track: 'park',
      review_status: 'rejected',
      valid_until: addDays(TODAY, 5),
    });
    await service.run(TODAY, NOW);
    expect(sent.map((s) => s.metadata?.certification)).toEqual([
      'csia:regular',
    ]);
  });

  it('only emails about the current upload per (org, track)', async () => {
    const { service, seed, sent } = setup();
    seed({ valid_until: addDays(TODAY, 10) });
    seed({ valid_until: addDays(TODAY, 400) });
    await service.run(TODAY, NOW);
    expect(sent).toEqual([]);
  });

  it('skips certifications no longer on the profile and inactive instructors', async () => {
    const { service, seed, sent, subjects, instructor } = setup();
    seed({ valid_until: addDays(TODAY, 10) });
    subjects.certifications.set(instructor.id, [
      { org: 'casi', track: 'park', level: 1 },
    ]);
    await service.run(TODAY, NOW);
    const other = subjects.seedInstructor({ is_active: false });
    subjects.certifications.set(other.id, [
      { org: 'csia', track: 'regular', level: 1 },
    ]);
    subjects.uploads.push(
      certificationUploadRow({
        instructor_id: other.id,
        valid_until: addDays(TODAY, 10),
      }),
    );
    await service.run(TODAY, NOW);
    expect(sent).toEqual([]);
  });

  it('uses the instructor’s language', async () => {
    const { service, seed, sent, uploads, instructor } = setup();
    uploads.languages.set(instructor.id, 'zh-CN');
    seed({ valid_until: addDays(TODAY, 1) });
    await service.run(TODAY, NOW);
    expect(sent[0].language).toBe('zh-CN');
  });

  it('releases the claim when the email is not sent so the next run retries', async () => {
    const { service, seed, sent, control, subjects } = setup('failed');
    seed({ valid_until: addDays(TODAY, 3) });
    await expect(service.run(TODAY, NOW)).resolves.toEqual({
      expiring: 0,
      expired: 0,
      failed: 1,
    });
    expect(subjects.uploads[0].expiry_reminder_sent_at).toBeNull();
    control.outcome = 'sent';
    await expect(service.run(TODAY, NOW)).resolves.toMatchObject({
      expiring: 1,
    });
    expect(sent).toHaveLength(2);
  });

  it('skips an upload another run claimed first', async () => {
    const { service, seed, sent, uploads } = setup();
    seed({ valid_until: addDays(TODAY, 3) });
    jest
      .spyOn(uploads, 'swapExpiryReminderSentAt')
      .mockResolvedValueOnce(false);
    await expect(service.run(TODAY, NOW)).resolves.toEqual({
      expiring: 0,
      expired: 0,
      failed: 0,
    });
    expect(sent).toEqual([]);
  });

  it('resends for a corrected date after the admin cleared the reminder', async () => {
    const { service, seed, sent, subjects } = setup();
    seed({ valid_until: addDays(TODAY, 10) });
    await service.run(TODAY, NOW);
    subjects.uploads[0].valid_until = addDays(TODAY, 375);
    subjects.uploads[0].expiry_reminder_sent_at = null;
    await service.run(addDays(TODAY, 345));
    expect(sent.map((s) => s.template)).toEqual([
      'certification.expiring',
      'certification.expiring',
    ]);
  });

  it('stamps the run day when called for a day other than today', async () => {
    const { service, seed, subjects } = setup();
    seed({ valid_until: '2027-01-15' });
    await service.run('2027-01-01', NOW);
    expect(subjects.uploads[0].expiry_reminder_sent_at).toBe(
      '2027-01-01T05:00:00.000Z',
    );
  });

  it.each([
    ['2026-11-01', '2026-11-01T04:00:00.000Z'],
    ['2026-11-02', '2026-11-02T05:00:00.000Z'],
  ])(
    'stamps Toronto midnight of %s across the DST change',
    async (day, sentAt) => {
      const { service, seed, subjects } = setup();
      seed({ valid_until: addDays(day, 10) });
      await service.run(day, NOW);
      expect(subjects.uploads[0].expiry_reminder_sent_at).toBe(sentAt);
    },
  );

  it('stamps now when the run day is the Toronto date of now, even after UTC midnight', async () => {
    const { service, seed, subjects } = setup();
    const now = new Date('2026-10-14T02:00:00.000Z');
    seed({ valid_until: '2026-10-20' });
    await service.run('2026-10-13', now);
    expect(subjects.uploads[0].expiry_reminder_sent_at).toBe(now.toISOString());
  });

  it('sends the expired email the Toronto day after an expiring email sent at 22:00 Toronto on the last day', async () => {
    const { service, seed, sent } = setup();
    seed({ valid_until: '2026-10-13' });
    await expect(
      service.run('2026-10-13', new Date('2026-10-14T02:00:00.000Z')),
    ).resolves.toMatchObject({ expiring: 1, expired: 0 });
    await expect(
      service.run('2026-10-14', new Date('2026-10-14T13:00:00.000Z')),
    ).resolves.toMatchObject({ expiring: 0, expired: 1 });
    expect(sent.map((s) => s.template)).toEqual([
      'certification.expiring',
      'certification.expired',
    ]);
  });

  it('defaults to today', async () => {
    const { service, sent } = setup();
    await service.run();
    expect(sent).toEqual([]);
  });
});
