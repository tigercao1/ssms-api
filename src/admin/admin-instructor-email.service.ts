import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  ActivationService,
  normalizeEmail,
} from '../activation/activation.service';
import type { InviteMoveCounts } from '../activation/activation.types';
import { AuditService } from '../audit/audit.service';
import {
  AUDIT_ACTIONS,
  type AuditActor,
  type AuditEntry,
} from '../audit/audit.types';
import { resolveEmailLanguage } from '../mailer/email-language';
import { MailerService, redactEmail } from '../mailer/mailer.service';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import type {
  AdminInstructorRecord,
  AdminInstructorRow,
  AuditRecord,
  AuthEmailUpdate,
} from './admin.types';
import type { UpdateInstructorEmailDto } from './dto/update-instructor-email.dto';

type FollowUpStep = 'sessions' | 'invites';

type ChangeStatus =
  | 'started'
  | 'superseding'
  | 'stale'
  | 'aborted'
  | 'superseded'
  | 'incomplete'
  | 'completed';

interface EmailChange {
  expected: string;
  email: string;
  key: string;
  actor: AuditActor;
}

interface UnfinishedChange {
  inFlight: boolean;
  notified: boolean;
}

const FOLLOW_UP_LABELS: Record<FollowUpStep, string> = {
  sessions: 'signing the instructor out',
  invites: 'moving their invites',
};

const IN_FLIGHT_MS = 15_000;
const IN_FLIGHT_POLL_MS = 500;
const CHANGE_HISTORY_ROWS = 20;
const OPEN_STATUSES: readonly unknown[] = ['started', 'superseding'];

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function latestOf(
  history: AuditRecord[],
  changeId: unknown,
): AuditRecord | undefined {
  return history.find(({ metadata }) => metadata.changeId === changeId);
}

function isOpen(record: AuditRecord | undefined): boolean {
  return record !== undefined && OPEN_STATUSES.includes(record.metadata.status);
}

function unfinishedIn(
  rows: AuditRecord[],
  key: string,
  skip?: string,
): UnfinishedChange | null {
  const unclaimed = new Set(
    rows
      .filter(
        ({ metadata }) =>
          metadata.status === 'stale' ||
          (metadata.status === 'aborted' && metadata.claimRestored === true),
      )
      .map(({ metadata }) => metadata.changeId),
  );
  const chain: typeof rows = [];
  for (const row of rows) {
    if (
      unclaimed.has(row.metadata.changeId) ||
      row.metadata.changeId === skip
    ) {
      continue;
    }
    if (row.metadata.changeKey !== key) {
      break;
    }
    chain.push(row);
  }
  const [latest] = chain;
  if (!latest || latest.metadata.status === 'completed') {
    return null;
  }
  return {
    inFlight: isRunning(latest),
    notified: chain.some(({ metadata }) => metadata.status === 'incomplete'),
  };
}

function isRunning(record: AuditRecord | undefined): boolean {
  return (
    record !== undefined &&
    isOpen(record) &&
    Date.now() - Date.parse(record.insertedAt) < IN_FLIGHT_MS
  );
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
    let row = await this.findRow(id);
    await this.assertChangeable(row, actor);

    const email = normalizeEmail(dto.email);
    const expected = normalizeEmail(dto.expectedCurrentEmail);
    const change: EmailChange = {
      expected,
      email,
      key: changeKey(row.id, expected, email),
      actor,
    };
    for (;;) {
      const current = normalizeEmail(row.email);
      if (current !== email) {
        if (expected !== current) {
          throw staleEmail();
        }
        await this.start(row, change);
        break;
      }
      if (expected === email) {
        throw new BadRequestException(
          'The instructor already uses this email address',
        );
      }
      const unfinished = unfinishedIn(await this.history(row.id), change.key);
      if (!unfinished) {
        throw staleEmail();
      }
      if (!unfinished.inFlight) {
        await this.resume(row, change, unfinished.notified);
        break;
      }
      await sleep(IN_FLIGHT_POLL_MS);
      row = await this.findRow(id);
    }
    return this.admin.getInstructor(id);
  }

  private async start(
    row: AdminInstructorRow,
    change: EmailChange,
  ): Promise<void> {
    await this.assertAvailable(change.email, row.auth_user_id);
    const oldEmail =
      (await this.repo.findAuthEmail(row.auth_user_id)) ?? row.email;
    const inviteEmails = await this.inviteEmails(row, change);
    const changeId = await this.begin(row, change, {});
    if (
      !(await this.repo.claimInstructorEmail(row.id, row.email, change.email))
    ) {
      await this.audit.record(this.entry(row, change, changeId, 'stale'));
      throw staleEmail();
    }
    await this.takeOver(row, change, changeId, false);
    await this.moveAuthEmail(row, change, changeId, row.email);
    await this.finish(row, change, changeId, oldEmail, inviteEmails, {});
  }

  private async resume(
    row: AdminInstructorRow,
    change: EmailChange,
    notified: boolean,
  ): Promise<void> {
    const inviteEmails = await this.inviteEmails(row, change);
    const changeId = await this.begin(row, change, { resumed: true });
    await this.takeOver(row, change, changeId, true);
    await this.moveAuthEmail(row, change, changeId, null);
    await this.finish(
      row,
      change,
      changeId,
      notified ? null : change.expected,
      inviteEmails,
      { resumed: true },
    );
  }

  private async inviteEmails(
    row: AdminInstructorRow,
    change: EmailChange,
  ): Promise<Set<string>> {
    return new Set([
      change.expected,
      ...(await this.activation.inviteEmails(row.auth_user_id)),
    ]);
  }

  private async takeOver(
    row: AdminInstructorRow,
    change: EmailChange,
    changeId: string,
    resumed: boolean,
  ): Promise<void> {
    let history = await this.history(row.id);
    if (resumed && !unfinishedIn(history, change.key, changeId)) {
      await this.audit.record(this.entry(row, change, changeId, 'stale'));
      throw staleEmail();
    }
    const mine = history.findIndex(
      ({ metadata }) =>
        metadata.changeId === changeId && metadata.status === 'started',
    );
    const supersedes = history
      .filter(
        ({ metadata }, index) =>
          metadata.status === 'started' &&
          metadata.changeId !== changeId &&
          isOpen(latestOf(history, metadata.changeId)) &&
          (resumed
            ? index > mine && metadata.changeKey === change.key
            : index > mine || metadata.resumed === true),
      )
      .map(({ metadata }) => metadata.changeId);
    if (!supersedes.length) {
      return;
    }
    const superseding = () =>
      this.entry(row, change, changeId, 'superseding', { supersedes });
    await this.repo.recordAudit(superseding());
    let waited = false;
    while (supersedes.some((id) => isRunning(latestOf(history, id)))) {
      waited = true;
      await sleep(IN_FLIGHT_POLL_MS);
      history = await this.assertCurrent(row, change, changeId);
    }
    if (waited) {
      await this.repo.recordAudit(superseding());
    }
  }

  private async assertCurrent(
    row: AdminInstructorRow,
    change: EmailChange,
    changeId: string,
  ): Promise<AuditRecord[]> {
    const history = await this.history(row.id);
    const started = history.some(
      ({ metadata }) =>
        metadata.changeId === changeId && metadata.status === 'started',
    );
    const superseded = history.some(
      ({ metadata }) =>
        metadata.status === 'superseding' &&
        Array.isArray(metadata.supersedes) &&
        metadata.supersedes.includes(changeId),
    );
    if (started && !superseded) {
      return history;
    }
    await this.audit.record(this.entry(row, change, changeId, 'superseded'));
    throw staleEmail();
  }

  private history(instructorId: string): Promise<AuditRecord[]> {
    return this.repo.listAuditEntries(
      AUDIT_ACTIONS.instructorEmailChange,
      instructorId,
      CHANGE_HISTORY_ROWS,
    );
  }

  private async begin(
    row: AdminInstructorRow,
    change: EmailChange,
    metadata: Record<string, unknown>,
  ): Promise<string> {
    const changeId = randomUUID();
    await this.repo.recordAudit(
      this.entry(row, change, changeId, 'started', metadata),
    );
    return changeId;
  }

  private entry(
    row: AdminInstructorRow,
    change: EmailChange,
    changeId: string,
    status: ChangeStatus,
    metadata: Record<string, unknown> = {},
  ): AuditEntry {
    return {
      action: AUDIT_ACTIONS.instructorEmailChange,
      actor: { ...change.actor, role: 'admin' },
      targetType: 'instructor',
      targetId: row.id,
      metadata: {
        changeId,
        changeKey: change.key,
        status,
        from: redactEmail(change.expected),
        to: redactEmail(change.email),
        ...metadata,
      },
    };
  }

  private async findRow(id: string): Promise<AdminInstructorRow> {
    const row = await this.repo.findInstructorById(id);
    if (!row) {
      throw new NotFoundException('Instructor not found');
    }
    return row;
  }

  private async moveAuthEmail(
    row: AdminInstructorRow,
    change: EmailChange,
    changeId: string,
    restoreTo: string | null,
  ): Promise<void> {
    await this.assertCurrent(row, change, changeId);
    const authEmail = await this.repo.findAuthEmail(row.auth_user_id);
    if (normalizeEmail(authEmail ?? '') === change.email) {
      return;
    }
    try {
      await this.updateAuthEmail(row.auth_user_id, change.email);
    } catch (err) {
      await this.assertCurrent(row, change, changeId);
      const claimRestored = await this.releaseClaim(
        row,
        change.email,
        restoreTo ?? authEmail ?? change.expected,
      );
      await this.audit.record(
        this.entry(row, change, changeId, 'aborted', { claimRestored }),
      );
      throw err;
    }
  }

  private async releaseClaim(
    row: AdminInstructorRow,
    email: string,
    restoreTo: string,
  ): Promise<boolean> {
    try {
      return await this.repo.claimInstructorEmail(row.id, email, restoreTo);
    } catch (err) {
      this.logFailure(row.id, 'restore the instructor email', err);
      return false;
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
    change: EmailChange,
    changeId: string,
    oldEmail: string | null,
    inviteEmails: ReadonlySet<string>,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const failed: FollowUpStep[] = [];
    let sessionsRevoked: number | null = null;
    let invites: InviteMoveCounts | null = null;
    await this.assertCurrent(row, change, changeId);
    try {
      sessionsRevoked = await this.repo.revokeSessions(row.auth_user_id);
    } catch (err) {
      failed.push('sessions');
      this.logFailure(row.id, 'revoke sessions', err);
    }
    await this.assertCurrent(row, change, changeId);
    try {
      invites = await this.activation.moveInvites(
        row.auth_user_id,
        change.email,
        inviteEmails,
      );
    } catch (err) {
      failed.push('invites');
      this.logFailure(row.id, 'move invites', err);
    }
    if (oldEmail !== null) {
      await this.assertCurrent(row, change, changeId);
      this.notify(row, oldEmail, change.email);
    }

    await this.assertCurrent(row, change, changeId);
    await this.audit.record(
      this.entry(
        row,
        change,
        changeId,
        failed.length ? 'incomplete' : 'completed',
        {
          ...metadata,
          sessionsRevoked,
          invitesMoved: invites?.moved ?? null,
          invitesReissued: invites?.reissued ?? null,
          ...(failed.length ? { failed } : {}),
        },
      ),
    );

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
