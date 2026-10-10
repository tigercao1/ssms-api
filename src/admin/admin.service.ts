import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BIO_TRANSLATOR,
  type BioLang,
  type BioTranslator,
} from '../bio-translation/bio-translator.interface';
import { InstructorsService } from '../instructors/instructors.service';
import type { UpdateInstructorProfileDto } from '../instructors/dto/update-instructor-profile.dto';
import type { InstructorProfile } from '../instructors/instructors.types';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { MailerService } from '../mailer/mailer.service';
import type {
  InstructorNotificationContext,
  NotificationType,
} from '../mailer/mailer.types';
import { AdminRepository } from './admin.repository';
import {
  AdminInstructorRecord,
  AdminInstructorRow,
  CreateReferenceInput,
  CurrentUserRoleRecord,
  DeletedReferenceRecord,
  ListInstructorsFilter,
  REFERENCE_SLUG_TO_TABLE,
  REFERENCE_TABLE_TO_JUNCTION,
  ReferencePatch,
  ReferenceRecord,
  ReferenceRow,
  ReferenceSlug,
  ReferenceUsage,
  UpdateReferenceInput,
  UserRole,
  UserRoleRecord,
} from './admin.types';
import { CreateReferenceDto } from './dto/create-reference.dto';

/** Postgres unique-violation — duplicate reference `key`. */
const PG_UNIQUE_VIOLATION = '23505';
const REFERENCE_TRANSLATION_TIMEOUT_MS = 8_000;
const REFERENCE_NAME_MAX_LENGTH = 200;
export const ENGLISH_NAME_REQUIRED =
  'English name required (translation unavailable)';

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

interface PostgresError {
  code?: string;
  message?: string;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly repo: AdminRepository,
    /**
     * Reused for T6.6 — admin edits any instructor's profile through the same
     * transactional update path as self-service (`updateProfileById`), so the
     * RPC, validation and bio-translation enqueue all behave identically.
     */
    private readonly instructors: InstructorsService,
    private readonly audit: AuditService,
    /**
     * T8.1 — transactional email on approve / reject / deactivate. The mailer
     * is fire-and-forget: it resolves (never rejects) to a `SendOutcome` and a
     * failure never rolls back the admin transition or bubbles to the client.
     */
    private readonly mailer: MailerService,
    @Inject(BIO_TRANSLATOR) private readonly translator: BioTranslator,
  ) {}

  /**
   * Fires an instructor notification without letting a mailer failure surface
   * to the caller. The mailer already retries + audits `notification.failure`;
   * this wrapper adds the fire-and-forget guarantee at the call site.
   */
  private notifyInstructor(
    row: AdminInstructorRow,
    type: NotificationType,
    extra: Partial<InstructorNotificationContext> = {},
  ): void {
    void this.mailer
      .sendInstructorNotification({
        to: row.email,
        type,
        language: row.preferred_language,
        displayName: row.display_name_en,
        instructorId: row.id,
        ...extra,
      })
      .catch(() => {
        // MailerService is contracted never to reject, but be defensive so a
        // regression there can never break an admin action.
      });
  }

  /** T6.3 — list every instructor, optionally narrowed by status / active. */
  async listInstructors(
    filter: ListInstructorsFilter,
  ): Promise<AdminInstructorRecord[]> {
    const rows = await this.repo.listInstructors(filter);
    return rows.map((row) => this.toRecord(row));
  }

  /** Fetch a single instructor's core record (admin detail). */
  async getInstructor(id: string): Promise<AdminInstructorRecord> {
    const row = await this.repo.findInstructorById(id);
    if (!row) {
      throw new NotFoundException('Instructor not found');
    }
    return this.toRecord(row);
  }

  async getInstructorProfile(id: string): Promise<InstructorProfile> {
    return this.instructors.getProfileById(id);
  }

  async getUserRole(authUserId: string): Promise<CurrentUserRoleRecord> {
    const current = await this.repo.getUserRole(authUserId);
    if (!current.found) {
      throw new NotFoundException('User not found');
    }
    return { role: current.role ?? 'instructor' };
  }

  /**
   * T6.4 — approve / reject a pending instructor. Valid transitions only:
   * `pending → approved` and `pending → rejected`. Anything else is a 4xx.
   *
   * On success appends an `instructor.approve` / `instructor.reject` row to
   * `audit_log` (T6.8); `reason` is carried into the audit metadata (and the
   * rejection email — T8.1).
   */
  async setApprovalStatus(
    id: string,
    status: 'approved' | 'rejected',
    reason?: string,
    actor?: AuditActor,
  ): Promise<AdminInstructorRecord> {
    const current = await this.repo.findInstructorById(id);
    if (!current) {
      throw new NotFoundException('Instructor not found');
    }
    if (current.approval_status !== 'pending') {
      throw new BadRequestException(
        `Cannot ${status === 'approved' ? 'approve' : 'reject'} an instructor ` +
          `in '${current.approval_status}' state; only 'pending' is allowed`,
      );
    }

    const updated = await this.repo.updateInstructor(id, {
      approval_status: status,
    });
    if (!updated) {
      throw new NotFoundException('Instructor not found');
    }

    await this.audit.record({
      action:
        status === 'approved'
          ? AUDIT_ACTIONS.instructorApprove
          : AUDIT_ACTIONS.instructorReject,
      actor: { ...actor, role: 'admin' },
      targetType: 'instructor',
      targetId: id,
      metadata: {
        from: current.approval_status,
        to: status,
        reason: reason ?? null,
      },
    });

    // T8.1 — fire-and-forget notification (approved / rejected). Failures are
    // audited by the mailer and MUST NOT roll back the transition.
    this.notifyInstructor(updated, status, { reason: reason ?? null });

    return this.toRecord(updated);
  }

  /**
   * T6.5 — activate / deactivate. Deactivation (`is_active = false`) removes
   * the instructor from the public API (which filters on `is_active = true`).
   * Allowed from any approval state.
   */
  async setActive(
    id: string,
    isActive: boolean,
    actor?: AuditActor,
  ): Promise<AdminInstructorRecord> {
    const current = await this.repo.findInstructorById(id);
    if (!current) {
      throw new NotFoundException('Instructor not found');
    }

    const updated = await this.repo.updateInstructor(id, {
      is_active: isActive,
    });
    if (!updated) {
      throw new NotFoundException('Instructor not found');
    }

    await this.audit.record({
      action: isActive
        ? AUDIT_ACTIONS.instructorActivate
        : AUDIT_ACTIONS.instructorDeactivate,
      actor: { ...actor, role: 'admin' },
      targetType: 'instructor',
      targetId: id,
      metadata: { from: current.is_active, to: isActive },
    });

    // T8.1 — notify only on deactivation. Reactivation is a silent admin
    // correction (the instructor may not know they were ever deactivated).
    if (!isActive && current.is_active) {
      this.notifyInstructor(updated, 'deactivated');
    }

    return this.toRecord(updated);
  }

  async setDisplayOrder(
    id: string,
    displayOrder: number | null,
    actor?: AuditActor,
  ): Promise<AdminInstructorRecord> {
    const current = await this.repo.findInstructorById(id);
    if (!current) {
      throw new NotFoundException('Instructor not found');
    }

    const updated = await this.repo.updateInstructor(id, {
      display_order: displayOrder,
    });
    if (!updated) {
      throw new NotFoundException('Instructor not found');
    }

    await this.audit.record({
      action: AUDIT_ACTIONS.instructorDisplayOrderUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'instructor',
      targetId: id,
      metadata: { from: current.display_order, to: displayOrder },
    });

    return this.toRecord(updated);
  }

  /**
   * T6.6 — full edit of any instructor's profile. Delegates to the reusable
   * transactional updater exported by InstructorsService, returning the same
   * rich `InstructorProfile` presenter the self-service route returns.
   */
  async updateProfile(
    id: string,
    dto: UpdateInstructorProfileDto,
  ): Promise<InstructorProfile> {
    return this.instructors.updateProfileById(id, dto);
  }

  /**
   * v1.x — promote / demote a user by setting the server-only
   * `app_metadata.role` (ADMIN_ROLE_PLAN.md). Writes a single `user.role_change`
   * audit row on an actual change; a no-op (already that role) is idempotent and
   * un-audited. An admin cannot change their own role (avoids self-lockout).
   */
  async setUserRole(
    authUserId: string,
    role: UserRole,
    actor?: AuditActor,
  ): Promise<UserRoleRecord> {
    if (actor?.userId && actor.userId === authUserId) {
      throw new BadRequestException('You cannot change your own role');
    }

    const current = await this.repo.getUserRole(authUserId);
    if (!current.found) {
      throw new NotFoundException('User not found');
    }

    const previousRole = current.role;
    if (previousRole === role) {
      return { userId: authUserId, role, previousRole, changed: false };
    }

    await this.repo.setUserRole(authUserId, role);

    await this.audit.record({
      action: AUDIT_ACTIONS.userRoleChange,
      actor: { ...actor, role: 'admin' },
      targetType: 'user',
      targetId: authUserId,
      metadata: { from: previousRole, to: role },
    });

    return { userId: authUserId, role, previousRole, changed: true };
  }

  /**
   * T6.7 — append a row to a reference (lookup) table. Validates the slug,
   * applies column defaults, and maps a duplicate `key` to a 409.
   */
  async addReference(
    slug: ReferenceSlug,
    dto: CreateReferenceDto,
  ): Promise<ReferenceRecord> {
    const table = REFERENCE_SLUG_TO_TABLE[slug];
    if (!table) {
      // Defensive — the controller validates the slug, but keep the invariant.
      throw new BadRequestException(`Unknown reference type '${slug}'`);
    }

    const name = blankToNull(dto.name);
    const nameZh = blankToNull(dto.nameZh);
    if (name === null && nameZh === null) {
      throw new BadRequestException('Provide name or nameZh');
    }
    const input: CreateReferenceInput = {
      key: dto.key,
      name: name ?? '',
      nameZh,
      nameEnTranslatedBy: null,
      nameZhTranslatedBy: null,
      sortOrder: dto.sortOrder ?? 0,
      isActive: dto.isActive ?? true,
    };
    if (name === null) {
      const translated = await this.translateName(nameZh!, 'zh-CN', 'en');
      if (translated === null) {
        throw new UnprocessableEntityException(ENGLISH_NAME_REQUIRED);
      }
      input.name = translated;
      input.nameEnTranslatedBy = this.translator.modelId;
    } else if (nameZh === null) {
      input.nameZh = await this.translateName(name, 'en', 'zh-CN');
      input.nameZhTranslatedBy =
        input.nameZh === null ? null : this.translator.modelId;
    }

    try {
      const row = await this.repo.insertReference(table, input);
      return this.toReferenceRecord(row);
    } catch (err) {
      const pgErr = err as PostgresError;
      if (pgErr?.code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException(
          `A '${slug}' entry with key '${dto.key}' already exists`,
        );
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async listReferences(slug: ReferenceSlug): Promise<ReferenceRecord[]> {
    const rows = await this.repo.listReferences(REFERENCE_SLUG_TO_TABLE[slug]);
    return rows.map((row) => this.toReferenceRecord(row));
  }

  async updateReference(
    slug: ReferenceSlug,
    id: string,
    input: UpdateReferenceInput,
    actor?: AuditActor,
  ): Promise<ReferenceRecord> {
    if (
      input.name === undefined &&
      input.nameZh === undefined &&
      input.sortOrder === undefined &&
      input.isActive === undefined
    ) {
      throw new BadRequestException(
        'Provide at least one of name, nameZh, sortOrder, isActive',
      );
    }

    const table = REFERENCE_SLUG_TO_TABLE[slug];
    const current = await this.findReferenceOrThrow(slug, id);
    const patch = await this.buildReferencePatch(current, input);
    const updated = await this.repo.updateReference(table, id, patch);
    if (!updated) {
      throw this.referenceNotFound(slug, id);
    }

    const from: Record<string, unknown> = {};
    const to: Record<string, unknown> = {};
    for (const column of Object.keys(patch) as (keyof ReferencePatch)[]) {
      from[column] = current[column];
      to[column] = updated[column];
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.referenceUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'reference',
      targetId: id,
      metadata: { table, key: updated.key, from, to },
    });

    return this.toReferenceRecord(updated);
  }

  private async buildReferencePatch(
    current: ReferenceRow,
    input: UpdateReferenceInput,
  ): Promise<ReferencePatch> {
    const patch: ReferencePatch = {};
    const nameZh =
      input.nameZh === undefined ? undefined : blankToNull(input.nameZh);
    const nameEdited = input.name !== undefined && input.name !== current.name;
    const nameZhEdited = nameZh !== undefined && nameZh !== current.name_zh;
    if (input.name !== undefined) patch.name = input.name;
    if (nameEdited) patch.name_en_translated_by = null;
    if (nameZh !== undefined) patch.name_zh = nameZh;
    if (nameZhEdited) patch.name_zh_translated_by = null;
    if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
    if (input.isActive !== undefined) patch.is_active = input.isActive;

    if (
      nameEdited &&
      !nameZhEdited &&
      (current.name_zh === null || current.name_zh_translated_by !== null)
    ) {
      const translated = await this.translateName(input.name!, 'en', 'zh-CN');
      if (translated !== null) {
        patch.name_zh = translated;
        patch.name_zh_translated_by = this.translator.modelId;
      }
    } else if (
      nameZhEdited &&
      !nameEdited &&
      nameZh !== null &&
      current.name_en_translated_by !== null
    ) {
      const translated = await this.translateName(nameZh, 'zh-CN', 'en');
      if (translated !== null) {
        patch.name = translated;
        patch.name_en_translated_by = this.translator.modelId;
      }
    }
    return patch;
  }

  private async translateName(
    text: string,
    from: BioLang,
    to: BioLang,
  ): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const translated = await Promise.race([
        this.translator.translate({
          text,
          from,
          to,
          kind: 'reference-name',
          timeoutMs: REFERENCE_TRANSLATION_TIMEOUT_MS,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('timed out')),
            REFERENCE_TRANSLATION_TIMEOUT_MS,
          );
        }),
      ]);
      const name = blankToNull(translated);
      return name !== null && name.length <= REFERENCE_NAME_MAX_LENGTH
        ? name
        : null;
    } catch (err) {
      this.logger.warn(
        `Reference name translation ${from} -> ${to} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async getReferenceUsage(
    slug: ReferenceSlug,
    id: string,
  ): Promise<ReferenceUsage> {
    await this.findReferenceOrThrow(slug, id);
    const instructorCount = await this.repo.countReferenceLinks(
      REFERENCE_TABLE_TO_JUNCTION[REFERENCE_SLUG_TO_TABLE[slug]],
      id,
    );
    return { instructorCount };
  }

  async deleteReference(
    slug: ReferenceSlug,
    id: string,
    actor?: AuditActor,
  ): Promise<DeletedReferenceRecord> {
    const table = REFERENCE_SLUG_TO_TABLE[slug];
    await this.findReferenceOrThrow(slug, id);
    const removedLinkCount = await this.repo.countReferenceLinks(
      REFERENCE_TABLE_TO_JUNCTION[table],
      id,
    );
    const deleted = await this.repo.deleteReference(table, id);
    if (!deleted) {
      throw this.referenceNotFound(slug, id);
    }

    await this.audit.record({
      action: AUDIT_ACTIONS.referenceDelete,
      actor: { ...actor, role: 'admin' },
      targetType: 'reference',
      targetId: id,
      metadata: {
        table,
        key: deleted.key,
        name: deleted.name,
        removedLinkCount,
      },
    });

    return { ...this.toReferenceRecord(deleted), removedLinkCount };
  }

  private async findReferenceOrThrow(
    slug: ReferenceSlug,
    id: string,
  ): Promise<ReferenceRow> {
    const row = await this.repo.findReferenceById(
      REFERENCE_SLUG_TO_TABLE[slug],
      id,
    );
    if (!row) {
      throw this.referenceNotFound(slug, id);
    }
    return row;
  }

  private referenceNotFound(
    slug: ReferenceSlug,
    id: string,
  ): NotFoundException {
    return new NotFoundException(`No '${slug}' entry with id '${id}'`);
  }

  private toRecord(row: AdminInstructorRow): AdminInstructorRecord {
    return {
      id: row.id,
      authUserId: row.auth_user_id,
      email: row.email,
      displayNameEn: row.display_name_en,
      displayNameZh: row.display_name_zh,
      bioEn: row.bio_en,
      bioZh: row.bio_zh,
      dateOfBirth: row.date_of_birth,
      profilePhotoUrl: row.profile_photo_url,
      minStudentAge: row.min_student_age,
      displayOrder: row.display_order,
      preferredLanguage: row.preferred_language,
      approvalStatus: row.approval_status,
      isActive: row.is_active,
      insertedAt: row.inserted_at,
      updatedAt: row.updated_at,
    };
  }

  private toReferenceRecord(row: ReferenceRow): ReferenceRecord {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      nameZh: row.name_zh,
      nameEnTranslatedBy: row.name_en_translated_by,
      nameZhTranslatedBy: row.name_zh_translated_by,
      sortOrder: row.sort_order,
      isActive: row.is_active,
    };
  }
}
