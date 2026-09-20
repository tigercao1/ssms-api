import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
  ListInstructorsFilter,
  REFERENCE_SLUG_TO_TABLE,
  ReferenceRecord,
  ReferenceRow,
  ReferenceSlug,
  UserRole,
  UserRoleRecord,
} from './admin.types';
import { CreateReferenceDto } from './dto/create-reference.dto';

/** Postgres unique-violation — duplicate reference `key`. */
const PG_UNIQUE_VIOLATION = '23505';

interface PostgresError {
  code?: string;
  message?: string;
}

@Injectable()
export class AdminService {
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

    const input: CreateReferenceInput = {
      key: dto.key,
      name: dto.name,
      sortOrder: dto.sortOrder ?? 0,
      isActive: dto.isActive ?? true,
    };

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
      sortOrder: row.sort_order,
      isActive: row.is_active,
    };
  }
}
