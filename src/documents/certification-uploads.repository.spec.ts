import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { DatabaseError } from '../database/db-result';
import {
  EXPIRY_CANDIDATE_COLUMNS,
  SupabaseCertificationUploadsRepository,
} from './certification-uploads.repository';
import {
  CERTIFICATION_UPLOAD_COLUMNS,
  INSTRUCTOR_ID_CHUNK,
} from './document-subjects.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const fail = { data: null, error: { message: 'boom' } };
const ok = (data: unknown) => ({ data, error: null });
const newRow = {
  id: ID,
  instructor_id: ID,
  org: 'csia' as const,
  track: 'regular' as const,
  file_key: 'k',
  sha256: 'a'.repeat(64),
  content_type: 'application/pdf',
  size_bytes: 10,
  valid_until: '2027-01-01',
};

describe('SupabaseCertificationUploadsRepository', () => {
  it('finds, inserts and updates uploads', async () => {
    const row = { id: ID };
    const { client, queries } = recordingSupabase({
      certification_uploads: [
        ok(row),
        ok(null),
        ok(row),
        ok(row),
        ok(null),
        ok(row),
      ],
    });
    const repo = new SupabaseCertificationUploadsRepository(client);
    await expect(repo.findById(ID)).resolves.toEqual(row);
    await expect(repo.findById(ID)).resolves.toBeNull();
    await expect(repo.insert(newRow)).resolves.toEqual(row);
    await expect(
      repo.update(ID, { review_status: 'approved' }),
    ).resolves.toEqual(row);
    await expect(repo.update(ID, { review_note: null })).resolves.toBeNull();
    await expect(
      repo.update(ID, { review_status: 'approved' }, ['pending', 'approved']),
    ).resolves.toEqual(row);
    expect(queries[0].ops).toEqual([
      ['select', CERTIFICATION_UPLOAD_COLUMNS],
      ['eq', 'id', ID],
      ['maybeSingle'],
    ]);
    expect(queries[2].ops).toEqual([
      ['insert', newRow],
      ['select', CERTIFICATION_UPLOAD_COLUMNS],
      ['single'],
    ]);
    expect(queries[3].ops).toEqual([
      ['update', { review_status: 'approved' }],
      ['eq', 'id', ID],
      ['select', CERTIFICATION_UPLOAD_COLUMNS],
      ['maybeSingle'],
    ]);
    expect(queries[5].ops).toEqual([
      ['update', { review_status: 'approved' }],
      ['eq', 'id', ID],
      ['in', 'review_status', ['pending', 'approved']],
      ['select', CERTIFICATION_UPLOAD_COLUMNS],
      ['maybeSingle'],
    ]);
  });

  it('lists expiry candidates in the date window with their instructor', async () => {
    const { client, queries } = recordingSupabase({
      certification_uploads: [ok([{ id: ID }]), ok(null)],
    });
    const repo = new SupabaseCertificationUploadsRepository(client);
    await expect(
      repo.listExpiryCandidates('2026-10-05', '2026-11-12'),
    ).resolves.toEqual([{ id: ID }]);
    await expect(
      repo.listExpiryCandidates('2026-10-05', '2026-11-12'),
    ).resolves.toEqual([]);
    expect(queries[0].ops).toEqual([
      ['select', EXPIRY_CANDIDATE_COLUMNS],
      ['in', 'review_status', ['pending', 'approved']],
      ['gte', 'valid_until', '2026-10-05'],
      ['lt', 'valid_until', '2026-11-12'],
      ['order', 'valid_until', { ascending: true }],
    ]);
    expect(EXPIRY_CANDIDATE_COLUMNS).toContain(
      'instructor:instructors(id, auth_user_id, email, display_name_en, preferred_language, is_active, approval_status)',
    );
  });

  it('reads upload keys and certifications in instructor-id chunks', async () => {
    const ids = Array.from(
      { length: INSTRUCTOR_ID_CHUNK + 1 },
      (_, i) => `id-${i}`,
    );
    const { client, queries } = recordingSupabase({
      certification_uploads: [ok([{ id: 'a' }]), ok(null)],
      instructor_certifications: [ok([{ org: 'csia' }]), ok([{ org: 'casi' }])],
    });
    const repo = new SupabaseCertificationUploadsRepository(client);
    await expect(repo.listUploadKeys(ids)).resolves.toEqual([{ id: 'a' }]);
    await expect(repo.listCertifications(ids)).resolves.toEqual([
      { org: 'csia' },
      { org: 'casi' },
    ]);
    expect(queries.map((q) => q.table)).toEqual([
      'certification_uploads',
      'certification_uploads',
      'instructor_certifications',
      'instructor_certifications',
    ]);
    expect(queries[0].ops).toEqual([
      ['select', 'id, instructor_id, org, track, inserted_at'],
      ['in', 'instructor_id', ids.slice(0, INSTRUCTOR_ID_CHUNK)],
    ]);
    expect(queries[3].ops).toEqual([
      ['select', 'instructor_id, org, track, level'],
      ['in', 'instructor_id', ids.slice(INSTRUCTOR_ID_CHUNK)],
    ]);
  });

  it('swaps expiry_reminder_sent_at only from the expected value', async () => {
    const { client, queries } = recordingSupabase({
      certification_uploads: [ok([{ id: ID }]), ok([]), ok(null)],
    });
    const repo = new SupabaseCertificationUploadsRepository(client);
    await expect(
      repo.swapExpiryReminderSentAt(ID, null, '2026-10-12T00:00:00Z'),
    ).resolves.toBe(true);
    await expect(
      repo.swapExpiryReminderSentAt(ID, '2026-10-12T00:00:00Z', null),
    ).resolves.toBe(false);
    await expect(repo.swapExpiryReminderSentAt(ID, null, 'x')).resolves.toBe(
      false,
    );
    expect(queries[0].ops).toEqual([
      ['update', { expiry_reminder_sent_at: '2026-10-12T00:00:00Z' }],
      ['eq', 'id', ID],
      ['is', 'expiry_reminder_sent_at', null],
      ['select', 'id'],
    ]);
    expect(queries[1].ops).toEqual([
      ['update', { expiry_reminder_sent_at: null }],
      ['eq', 'id', ID],
      ['eq', 'expiry_reminder_sent_at', '2026-10-12T00:00:00Z'],
      ['select', 'id'],
    ]);
  });

  it.each([
    ['findById', (r: SupabaseCertificationUploadsRepository) => r.findById(ID)],
    ['insert', (r: SupabaseCertificationUploadsRepository) => r.insert(newRow)],
    ['update', (r: SupabaseCertificationUploadsRepository) => r.update(ID, {})],
    [
      'listExpiryCandidates',
      (r: SupabaseCertificationUploadsRepository) =>
        r.listExpiryCandidates('a', 'b'),
    ],
    [
      'listUploadKeys',
      (r: SupabaseCertificationUploadsRepository) => r.listUploadKeys([ID]),
    ],
    [
      'listCertifications',
      (r: SupabaseCertificationUploadsRepository) => r.listCertifications([ID]),
    ],
    [
      'swapExpiryReminderSentAt',
      (r: SupabaseCertificationUploadsRepository) =>
        r.swapExpiryReminderSentAt(ID, null, null),
    ],
  ])('%s surfaces database errors', async (_name, call) => {
    const { client } = recordingSupabase({
      certification_uploads: fail,
      instructor_certifications: fail,
    });
    await expect(
      call(new SupabaseCertificationUploadsRepository(client)),
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});
