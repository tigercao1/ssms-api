import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  formatCertification,
  formatTrainerStatus,
} from './cert-display.formatter';
import { InstructorsRepository } from './instructors.repository';
import {
  InstructorProfile,
  InstructorProfilePatch,
  InstructorRow,
} from './instructors.types';
import { UpdateInstructorProfileDto } from './dto/update-instructor-profile.dto';
import { TRANSLATION_QUEUE } from './translation-queue.port';
import type { TranslationQueuePort } from './translation-queue.port';

/** Postgres SQLSTATE classes that map to a 400 (client data problem). */
const CLIENT_ERROR_CODES = new Set([
  '23505', // unique_violation (duplicate (org, track))
  '23514', // check_violation (cert/trainer CHECK constraints)
  '23503', // foreign_key_violation (unknown reference id)
  '22007', // invalid_datetime_format
  '22008', // datetime_field_overflow
  '22P02', // invalid_text_representation (bad uuid / enum)
]);

interface PostgresError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

@Injectable()
export class InstructorsService {
  constructor(
    private readonly repo: InstructorsRepository,
    @Inject(TRANSLATION_QUEUE)
    private readonly translationQueue: TranslationQueuePort,
  ) {}

  /**
   * T3.1 — Get the caller's profile, creating a `pending` row on first verified
   * call and returning the same row idempotently thereafter.
   */
  async getOrCreateForUser(
    authUserId: string,
    email: string,
  ): Promise<InstructorProfile> {
    const existing = await this.repo.findByAuthUserId(authUserId);
    if (existing) {
      return this.buildProfile(existing);
    }

    const created = await this.repo.insertPending(authUserId, email);
    if (created) {
      return this.buildProfile(created);
    }

    // Lost an insert race against a concurrent first call — the row now exists.
    const raced = await this.repo.findByAuthUserId(authUserId);
    if (!raced) {
      // Extremely unlikely; surface rather than loop.
      throw new NotFoundException('Instructor profile could not be created');
    }
    return this.buildProfile(raced);
  }

  /**
   * T3.2 — Update the caller's own profile (resolved via JWT subject). Editable
   * in every approval_status; email is not part of the DTO so it stays immutable.
   */
  async updateOwnProfile(
    authUserId: string,
    dto: UpdateInstructorProfileDto,
  ): Promise<InstructorProfile> {
    const instructor = await this.repo.findByAuthUserId(authUserId);
    if (!instructor) {
      throw new NotFoundException('Instructor profile not found');
    }
    return this.updateProfileById(instructor.id, dto);
  }

  /**
   * T3.2 / T3.4 — Reusable transactional profile update by instructor id.
   *
   * Exported for reuse by the Admin module (A4 / T6.6 — admin edits any
   * instructor's profile). Applies the whole patch in one DB transaction
   * (update core row + replace relation rows) so partial writes are impossible,
   * then enqueues bio translation when exactly one bio language is present.
   */
  async updateProfileById(
    instructorId: string,
    dto: UpdateInstructorProfileDto,
  ): Promise<InstructorProfile> {
    const existing = await this.repo.findById(instructorId);
    if (!existing) {
      throw new NotFoundException('Instructor profile not found');
    }

    const patch = this.buildPatch(dto);
    const bioTouched = patch.bio_en !== undefined || patch.bio_zh !== undefined;
    try {
      await this.repo.applyProfilePatch(instructorId, patch);
    } catch (err) {
      throw this.toHttpError(err);
    }

    const updated = await this.repo.findById(instructorId);
    // Row was found above and updates never delete it; assert for the type.
    const profile = await this.buildProfile(updated ?? existing);
    // Only enqueue when a bio field was actually part of this update; the queue
    // then decides whether a translation is warranted.
    if (bioTouched) {
      await this.enqueueBioTranslation(profile);
    }
    return profile;
  }

  /**
   * Translate the validated DTO into a snake_case JSONB patch, including ONLY
   * the keys the client actually sent (presence detected via hasOwnProperty).
   * Omitted keys are left untouched by the RPC; empty arrays clear relations.
   */
  private buildPatch(dto: UpdateInstructorProfileDto): InstructorProfilePatch {
    const patch: InstructorProfilePatch = {};
    const has = (key: keyof UpdateInstructorProfileDto): boolean =>
      Boolean(Object.prototype.hasOwnProperty.call(dto, key));

    if (has('displayNameEn')) patch.display_name_en = dto.displayNameEn;
    if (has('displayNameZh')) patch.display_name_zh = dto.displayNameZh ?? null;
    if (has('bioEn')) patch.bio_en = dto.bioEn ?? null;
    if (has('bioZh')) patch.bio_zh = dto.bioZh ?? null;
    if (has('dateOfBirth')) patch.date_of_birth = dto.dateOfBirth ?? null;
    if (has('preferredLanguage'))
      patch.preferred_language = dto.preferredLanguage;
    if (has('profilePhotoUrl'))
      patch.profile_photo_url = dto.profilePhotoUrl ?? null;
    if (has('teachingLocationIds'))
      patch.teaching_location_ids = dto.teachingLocationIds ?? [];
    if (has('languageIds')) patch.language_ids = dto.languageIds ?? [];
    if (has('courseLevelOfferedIds'))
      patch.course_level_offered_ids = dto.courseLevelOfferedIds ?? [];

    if (has('certifications')) {
      patch.certifications = (dto.certifications ?? []).map((c) => ({
        org: c.org,
        track: c.track,
        level: c.level,
        is_partial: c.isPartial ?? false,
        partial_components: c.partialComponents ?? [],
        achieved_on: c.achievedOn ?? null,
      }));
    }

    if (has('trainerStatus')) {
      patch.trainer_status = (dto.trainerStatus ?? []).map((t) => ({
        discipline: t.discipline,
        rookie_session_completed: t.rookieSessionCompleted ?? false,
        trainer_exam_passed: t.trainerExamPassed ?? false,
        trainer_level: t.trainerLevel ?? null,
      }));
    }

    return patch;
  }

  /**
   * Hand the just-saved bios to the translation queue (T3.2 deliverable / T5.2).
   * The queue decides whether a job is needed (exactly one bio language present)
   * and swallows its own errors, so the profile save is never affected.
   */
  private async enqueueBioTranslation(
    profile: InstructorProfile,
  ): Promise<void> {
    await this.translationQueue.enqueueForProfile({
      instructorId: profile.id,
      bioEn: profile.bioEn,
      bioZh: profile.bioZh,
    });
  }

  /** Build the camelCase self-view profile, fanning out relation reads. */
  private async buildProfile(row: InstructorRow): Promise<InstructorProfile> {
    const [teachingLocations, languages, courseLevelsOffered, certs, trainers] =
      await Promise.all([
        this.repo.getTeachingLocations(row.id),
        this.repo.getLanguages(row.id),
        this.repo.getCourseLevels(row.id),
        this.repo.getCertifications(row.id),
        this.repo.getTrainerStatus(row.id),
      ]);

    return {
      id: row.id,
      email: row.email,
      displayNameEn: row.display_name_en,
      displayNameZh: row.display_name_zh,
      bioEn: row.bio_en,
      bioZh: row.bio_zh,
      bioEnMachineTranslated: row.bio_en_machine_translated,
      bioZhMachineTranslated: row.bio_zh_machine_translated,
      dateOfBirth: row.date_of_birth,
      preferredLanguage: row.preferred_language,
      approvalStatus: row.approval_status,
      isActive: row.is_active,
      profilePhotoUrl: row.profile_photo_url,
      teachingLocations,
      languages,
      courseLevelsOffered,
      certifications: certs.map((c) => ({
        org: c.org,
        track: c.track,
        level: c.level,
        isPartial: c.is_partial,
        partialComponents: c.partial_components ?? [],
        achievedOn: c.achieved_on,
        display: formatCertification({
          org: c.org,
          track: c.track,
          level: c.level,
          isPartial: c.is_partial,
        }),
      })),
      trainerStatus: trainers.map((t) => ({
        discipline: t.discipline,
        rookieSessionCompleted: t.rookie_session_completed,
        trainerExamPassed: t.trainer_exam_passed,
        trainerLevel: t.trainer_level,
        display: formatTrainerStatus({
          discipline: t.discipline,
          trainerLevel: t.trainer_level,
        }),
      })),
    };
  }

  /** Map known Postgres constraint errors to 400; otherwise rethrow. */
  private toHttpError(err: unknown): Error {
    const pgErr = err as PostgresError;
    if (pgErr?.code && CLIENT_ERROR_CODES.has(pgErr.code)) {
      return new BadRequestException(pgErr.message ?? 'Invalid profile update');
    }
    // Custom RAISE EXCEPTION messages from the RPC default to a 400 too, since
    // they signal bad client input (e.g. duplicate (org, track)).
    if (pgErr?.code === 'P0001') {
      return new BadRequestException(pgErr.message ?? 'Invalid profile update');
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
