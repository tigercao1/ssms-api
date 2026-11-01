import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  ActivationService,
  normalizeEmail,
} from '../activation/activation.service';
import type { InviteMoveCounts } from '../activation/activation.types';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { resolveEmailLanguage } from '../mailer/email-language';
import { MailerService, redactEmail } from '../mailer/mailer.service';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import type {
  AdminInstructorRecord,
  AdminInstructorRow,
  AuthEmailUpdate,
} from './admin.types';
import type { UpdateInstructorEmailDto } from './dto/update-instructor-email.dto';

type FollowUpStep = 'sessions' | 'invites';

const FOLLOW_UP_LABELS: Record<FollowUpStep, string> = {
  sessions: 'signing the instructor out',
  invites: 'moving their invites',
};

function emailTaken(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'email_taken',
    message: 'Another account already uses this email address',
  });
}

function staleEmail(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'stale_email',
    message: 'The instructor email address changed after this form was opened',
  });
}

function changeKey(instructorId: string, from: string, to: string): string {
  return createHash('sha256')
    .update(`${instructorId}\n${from}\n${to}`)
    .digest('hex');
}

function refused(code: string, message: string): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code,
    message,
  });
}

@Injectable()
export class AdminInstructorEmailService {
  private readonly logger = new Logger(AdminInstructorEmailService.name);

  constructor(
    private readonly repo: AdminRepository,
    private readonly admin: AdminService,
    private readonly activation: ActivationService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
  ) {}

  async changeEmail(
    id: string,
    dto: UpdateInstructorEmailDto,
    actor: AuditActor,
  ): Promise<AdminInstructorRecord> {
    const row = await this.repo.findInstructorById(id);
    if (!row) {
      throw new NotFoundException('Instructor not found');
    }
    await this.assertChangeable(row, actor);

    const email = normalizeEmail(dto.email);
    const expected = normalizeEmail(dto.expectedCurrentEmail);
    const current = normalizeEmail(row.email);
    const key = changeKey(row.id, expected, email);
    if (current === email) {
      if (expected === email) {
        throw new BadRequestException(
          'The instructor already uses this email address',
        );
      }
      if (!(await this.isUnfinished(row.id, key))) {
        throw staleEmail();
      }
      await this.finish(row, email, actor, { resumed: true, changeKey: key });
      return this.admin.getInstructor(id);
    }
    if (expected !== current) {
      throw staleEmail();
    }

    await this.assertAvailable(email, row.auth_user_id);
    if (!(await this.repo.claimInstructorEmail(row.id, row.email, email))) {
      throw staleEmail();
    }
    try {
      await this.updateAuthEmail(row.auth_user_id, email);
    } catch (err) {
      await this.releaseClaim(row, email);
      throw err;
    }
    this.notify(row, row.email, email);
    await this.finish(row, email, actor, {
      from: redactEmail(row.email),
      changeKey: key,
    });
    return this.admin.getInstructor(id);
  }

  private async isUnfinished(
    instructorId: string,
    key: string,
  ): Promise<boolean> {
    const last = await this.repo.findLatestAuditMetadata(
      AUDIT_ACTIONS.instructorEmailChange,
      instructorId,
    );
    return last?.changeKey === key && Array.isArray(last.failed);
  }

  private async releaseClaim(
    row: AdminInstructorRow,
    email: string,
  ): Promise<void> {
    try {
      await this.repo.claimInstructorEmail(row.id, email, row.email);
    } catch (err) {
      this.logFailure(row.id, 'restore the instructor email', err);
    }
  }

  private async assertChangeable(
    row: AdminInstructorRow,
    actor: AuditActor,
  ): Promise<void> {
    if (actor.userId === row.auth_user_id) {
      throw refused('self_target', 'You cannot change your own email here');
    }
    const role = await this.repo.getUserRole(row.auth_user_id);
    if (!role.found) {
      throw new NotFoundException('User not found');
    }
    if (role.role === 'admin') {
      throw refused(
        'admin_target',
        'Admin accounts cannot have their email changed here',
      );
    }
  }

  private async assertAvailable(
    email: string,
    authUserId: string,
  ): Promise<void> {
    const holder = await this.repo.findAuthUserIdByEmail(email);
    if (holder !== null && holder !== authUserId) {
      throw emailTaken();
    }
  }

  private async updateAuthEmail(
    authUserId: string,
    email: string,
  ): Promise<void> {
    let result: AuthEmailUpdate;
    try {
      result = await this.repo.updateAuthEmail(authUserId, email);
    } catch (err) {
      const holder = await this.repo.findAuthUserIdByEmail(email);
      if (holder === authUserId) {
        return;
      }
      if (holder !== null) {
        throw emailTaken();
      }
      throw err;
    }
    if (result === 'taken') {
      throw emailTaken();
    }
    if (result === 'invalid') {
      throw new BadRequestException('email must be an email');
    }
  }

  private notify(
    row: AdminInstructorRow,
    oldEmail: string,
    newEmail: string,
  ): void {
    const common = {
      language: resolveEmailLanguage(row.preferred_language),
      mode: 'background' as const,
      instructorId: row.id,
      authUserId: row.auth_user_id,
    };
    void this.mailer
      .send({
        ...common,
        template: 'email_changed.old_address',
        to: oldEmail,
        vars: { displayName: row.display_name_en, oldEmail, newEmail },
      })
      .catch(() => undefined);
    void this.mailer
      .send({
        ...common,
        template: 'email_changed.new_address',
        to: newEmail,
        vars: {
          displayName: row.display_name_en,
          newEmail,
          loginUrl: this.mailer.portalLink('/login'),
        },
      })
      .catch(() => undefined);
  }

  private async finish(
    row: AdminInstructorRow,
    email: string,
    actor: AuditActor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const failed: FollowUpStep[] = [];
    let sessionsRevoked: number | null = null;
    let invites: InviteMoveCounts | null = null;
    try {
      sessionsRevoked = await this.repo.revokeSessions(row.auth_user_id);
    } catch (err) {
      failed.push('sessions');
      this.logFailure(row.id, 'revoke sessions', err);
    }
    try {
      invites = await this.activation.moveInvites(row.auth_user_id, email);
    } catch (err) {
      failed.push('invites');
      this.logFailure(row.id, 'move invites', err);
    }

    await this.audit.record({
      action: AUDIT_ACTIONS.instructorEmailChange,
      actor: { ...actor, role: 'admin' },
      targetType: 'instructor',
      targetId: row.id,
      metadata: {
        ...metadata,
        to: redactEmail(email),
        sessionsRevoked,
        invitesMoved: invites?.moved ?? null,
        invitesReissued: invites?.reissued ?? null,
        ...(failed.length ? { failed } : {}),
      },
    });

    if (failed.length) {
      throw new InternalServerErrorException({
        statusCode: 500,
        error: 'Internal Server Error',
        code: 'email_change_incomplete',
        message: `The email address was changed, but ${failed.map((step) => FOLLOW_UP_LABELS[step]).join(' and ')} failed. Send the same request again to finish.`,
        failed,
      });
    }
  }

  private logFailure(id: string, step: string, err: unknown): void {
    this.logger.error(
      `Email change for instructor ${id}: could not ${step}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
