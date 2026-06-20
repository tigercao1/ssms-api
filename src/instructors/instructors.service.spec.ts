import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InstructorsService } from './instructors.service';
import { InstructorsRepository } from './instructors.repository';
import {
  CertificationRow,
  InstructorProfilePatch,
  InstructorRow,
  ReferenceRow,
  TrainerStatusRow,
} from './instructors.types';
import { UpdateInstructorProfileDto } from './dto/update-instructor-profile.dto';
import { TranslationQueuePort } from './translation-queue.port';

function makeRow(overrides: Partial<InstructorRow> = {}): InstructorRow {
  return {
    id: 'inst-1',
    auth_user_id: 'auth-1',
    email: 'a@b.com',
    display_name_en: '',
    display_name_zh: null,
    bio_en: null,
    bio_zh: null,
    bio_en_machine_translated: false,
    bio_zh_machine_translated: false,
    date_of_birth: null,
    profile_photo_url: null,
    preferred_language: 'en',
    approval_status: 'pending',
    is_active: true,
    inserted_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/** In-memory fake repo (TESTING_STRATEGY.md — repository fakes preferred). */
class FakeRepo extends InstructorsRepository {
  rows: InstructorRow[] = [];
  insertCalls = 0;
  lastPatch: InstructorProfilePatch | null = null;
  patchError: unknown = null;
  certs: CertificationRow[] = [];
  trainers: TrainerStatusRow[] = [];

  findByAuthUserId(authUserId: string): Promise<InstructorRow | null> {
    return Promise.resolve(
      this.rows.find((r) => r.auth_user_id === authUserId) ?? null,
    );
  }
  findById(id: string): Promise<InstructorRow | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }
  insertPending(
    authUserId: string,
    email: string,
  ): Promise<InstructorRow | null> {
    this.insertCalls += 1;
    const row = makeRow({
      id: `inst-${this.rows.length + 1}`,
      auth_user_id: authUserId,
      email,
    });
    this.rows.push(row);
    return Promise.resolve(row);
  }
  getTeachingLocations(): Promise<ReferenceRow[]> {
    return Promise.resolve([]);
  }
  getLanguages(): Promise<ReferenceRow[]> {
    return Promise.resolve([]);
  }
  getCourseLevels(): Promise<ReferenceRow[]> {
    return Promise.resolve([]);
  }
  getCertifications(): Promise<CertificationRow[]> {
    return Promise.resolve(this.certs);
  }
  getTrainerStatus(): Promise<TrainerStatusRow[]> {
    return Promise.resolve(this.trainers);
  }
  applyProfilePatch(_id: string, patch: InstructorProfilePatch): Promise<void> {
    this.lastPatch = patch;
    if (this.patchError) {
      // Intentionally reject with a Postgres-shaped error object (code/message),
      // not an Error instance, to exercise InstructorsService.toHttpError.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(this.patchError);
    }
    // reflect scalar fields back into the row so buildProfile sees the update
    const row = this.rows.find((r) => r.id === _id);
    if (row) {
      if (patch.bio_en !== undefined) row.bio_en = patch.bio_en;
      if (patch.bio_zh !== undefined) row.bio_zh = patch.bio_zh;
      if (patch.display_name_en !== undefined)
        row.display_name_en = patch.display_name_en;
    }
    return Promise.resolve();
  }
}

class FakeQueue implements TranslationQueuePort {
  calls: Array<{
    instructorId: string;
    bioEn?: string | null;
    bioZh?: string | null;
  }> = [];
  enqueueForProfile(snapshot: {
    instructorId: string;
    bioEn?: string | null;
    bioZh?: string | null;
  }): Promise<boolean> {
    this.calls.push(snapshot);
    return Promise.resolve(true);
  }
}

describe('InstructorsService', () => {
  let repo: FakeRepo;
  let queue: FakeQueue;
  let service: InstructorsService;

  beforeEach(() => {
    repo = new FakeRepo();
    queue = new FakeQueue();
    service = new InstructorsService(repo, queue);
  });

  describe('getOrCreateForUser (T3.1)', () => {
    it('auto-creates a pending row on first call', async () => {
      const profile = await service.getOrCreateForUser('auth-1', 'a@b.com');
      expect(repo.insertCalls).toBe(1);
      expect(profile.approvalStatus).toBe('pending');
      expect(profile.email).toBe('a@b.com');
      expect(profile.displayNameEn).toBe('');
      expect(profile.teachingLocations).toEqual([]);
      expect(profile.certifications).toEqual([]);
    });

    it('is idempotent — subsequent calls return the same row without re-inserting', async () => {
      const first = await service.getOrCreateForUser('auth-1', 'a@b.com');
      const second = await service.getOrCreateForUser('auth-1', 'a@b.com');
      expect(repo.insertCalls).toBe(1);
      expect(second.id).toBe(first.id);
    });

    it('recovers from an insert race (insertPending returns null)', async () => {
      const existing = makeRow({ id: 'inst-9', auth_user_id: 'auth-9' });
      repo.insertPending = (authUserId: string) => {
        repo.rows.push(makeRow({ id: 'inst-9', auth_user_id: authUserId }));
        return Promise.resolve(null);
      };
      const profile = await service.getOrCreateForUser('auth-9', 'x@y.com');
      expect(profile.id).toBe(existing.id);
    });
  });

  describe('updateOwnProfile / updateProfileById (T3.2/T3.4)', () => {
    beforeEach(() => {
      repo.rows.push(makeRow({ id: 'inst-1', auth_user_id: 'auth-1' }));
    });

    it('throws NotFound when the caller has no profile', async () => {
      await expect(
        service.updateOwnProfile('nobody', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('builds a patch containing ONLY the keys provided (email never present)', async () => {
      const dto = {
        displayNameEn: 'Jane',
        bioEn: 'hi',
      } as UpdateInstructorProfileDto;
      await service.updateOwnProfile('auth-1', dto);
      expect(repo.lastPatch).toEqual({
        display_name_en: 'Jane',
        bio_en: 'hi',
      });
      expect(repo.lastPatch).not.toHaveProperty('email');
    });

    it('treats an empty relation array as "clear" (key present)', async () => {
      const dto = {
        teachingLocationIds: [],
      } as unknown as UpdateInstructorProfileDto;
      await service.updateOwnProfile('auth-1', dto);
      expect(repo.lastPatch).toEqual({ teaching_location_ids: [] });
    });

    it('works in every approval_status (e.g. rejected)', async () => {
      repo.rows = [
        makeRow({
          id: 'inst-1',
          auth_user_id: 'auth-1',
          approval_status: 'rejected',
        }),
      ];
      const result = await service.updateOwnProfile('auth-1', {
        displayNameEn: 'Still Editable',
      });
      expect(result.approvalStatus).toBe('rejected');
      expect(result.displayNameEn).toBe('Still Editable');
    });

    it('maps cert structure to snake_case patch rows', async () => {
      const dto = {
        certifications: [
          {
            org: 'csia',
            track: 'regular',
            level: 3,
            isPartial: true,
            partialComponents: ['ski'],
            achievedOn: '2022-03-14',
          },
        ],
        trainerStatus: [
          { discipline: 'ski', rookieSessionCompleted: true, trainerLevel: 2 },
        ],
      } as UpdateInstructorProfileDto;
      await service.updateOwnProfile('auth-1', dto);
      expect(repo.lastPatch?.certifications).toEqual([
        {
          org: 'csia',
          track: 'regular',
          level: 3,
          is_partial: true,
          partial_components: ['ski'],
          achieved_on: '2022-03-14',
        },
      ]);
      expect(repo.lastPatch?.trainer_status).toEqual([
        {
          discipline: 'ski',
          rookie_session_completed: true,
          trainer_exam_passed: false,
          trainer_level: 2,
        },
      ]);
    });

    it('maps Postgres constraint errors to 400 BadRequest', async () => {
      repo.patchError = { code: '23505', message: 'duplicate (org, track)' };
      await expect(
        service.updateOwnProfile('auth-1', {
          displayNameEn: 'x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is reusable by id (admin path) — updateProfileById', async () => {
      const result = await service.updateProfileById('inst-1', {
        displayNameEn: 'Admin Edit',
      });
      expect(result.displayNameEn).toBe('Admin Edit');
    });

    it('updateProfileById throws NotFound for an unknown id', async () => {
      await expect(
        service.updateProfileById('ghost', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps P0001 (custom RAISE) errors to 400', async () => {
      repo.patchError = { code: 'P0001', message: 'instructor not found' };
      await expect(
        service.updateOwnProfile('auth-1', { displayNameEn: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rethrows non-Postgres errors unchanged', async () => {
      const boom = new Error('network down');
      repo.patchError = boom;
      await expect(
        service.updateOwnProfile('auth-1', { displayNameEn: 'x' }),
      ).rejects.toBe(boom);
    });

    it('builds display strings for certifications and trainer status', async () => {
      repo.certs = [
        {
          org: 'csia',
          track: 'regular',
          level: 3,
          is_partial: true,
          partial_components: ['ski'],
          achieved_on: '2022-03-14',
        },
        {
          org: 'casi',
          track: 'carving',
          level: 1,
          is_partial: false,
          partial_components: [],
          achieved_on: null,
        },
      ];
      repo.trainers = [
        {
          discipline: 'ski',
          rookie_session_completed: true,
          trainer_exam_passed: true,
          trainer_level: 2,
        },
        {
          discipline: 'snowboard',
          rookie_session_completed: false,
          trainer_exam_passed: false,
          trainer_level: null,
        },
      ];
      const profile = await service.updateProfileById('inst-1', {
        displayNameEn: 'Jane',
      });
      expect(profile.certifications.map((c) => c.display)).toEqual([
        'CSIA Level 3 Partial',
        'CASI Carving Level 1',
      ]);
      expect(profile.certifications[0].isPartial).toBe(true);
      expect(profile.trainerStatus.map((t) => t.display)).toEqual([
        'CSIA Level 2 Trainer',
        null,
      ]);
    });
  });

  describe('bio translation enqueue (T3.2/T5.2)', () => {
    beforeEach(() => {
      repo.rows.push(makeRow({ id: 'inst-1', auth_user_id: 'auth-1' }));
    });

    it('hands the saved bios to the queue when bio_en is in the patch', async () => {
      await service.updateOwnProfile('auth-1', { bioEn: 'English bio' });
      expect(queue.calls).toEqual([
        { instructorId: 'inst-1', bioEn: 'English bio', bioZh: null },
      ]);
    });

    it('hands the saved bios to the queue when bio_zh is in the patch', async () => {
      await service.updateOwnProfile('auth-1', { bioZh: '中文简介' });
      expect(queue.calls).toEqual([
        { instructorId: 'inst-1', bioEn: null, bioZh: '中文简介' },
      ]);
    });

    it('still delegates when both bios are set (the queue decides to no-op)', async () => {
      repo.rows = [
        makeRow({
          id: 'inst-1',
          auth_user_id: 'auth-1',
          bio_en: 'x',
          bio_zh: 'y',
        }),
      ];
      await service.updateOwnProfile('auth-1', { bioEn: 'x', bioZh: 'y' });
      expect(queue.calls).toEqual([
        { instructorId: 'inst-1', bioEn: 'x', bioZh: 'y' },
      ]);
    });

    it('does NOT call the queue when no bio field is part of the update', async () => {
      await service.updateOwnProfile('auth-1', { displayNameEn: 'No bios' });
      expect(queue.calls).toEqual([]);
    });
  });
});
