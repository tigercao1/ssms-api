import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { pageOffset } from '../database/pagination';
import { PrivateStorageClient } from '../documents/private-storage.client';
import { storageKeys } from '../documents/storage-keys';
import { readOptional } from '../mailer/mailer.config';
import { MailerService } from '../mailer/mailer.service';
import { BugReportsRepository } from './bug-reports.repository';
import {
  BUG_REPORT_LIMITS,
  type BugReportDetail,
  type BugReportItem,
  type BugReportRow,
  MAX_SCREENSHOT_BYTES,
  type NewBugReport,
  SCREENSHOT_CONTENT_TYPES,
  SCREENSHOT_EXTENSIONS,
  SCREENSHOT_LIMITS,
  type ScreenshotUploadUrl,
} from './bug-reports.types';
import {
  BUG_REPORT_DEFAULT_LIMIT,
  type BugReportsQueryDto,
  cleanLine,
  type ScreenshotUploadUrlDto,
  type SubmitBugReportDto,
  type UpdateBugReportDto,
} from './dto/bug-report.dto';

export const SCREENSHOT_NOT_YOURS =
  'screenshotKey must be a screenshot you uploaded';
export const SCREENSHOT_MISSING =
  'No screenshot found; upload it to the upload URL first';
export const SCREENSHOT_INVALID = `The screenshot must be a PNG, JPEG or WebP image of at most ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MB`;
export const BUG_REPORT_NOT_FOUND = 'Bug report not found';
export const BUG_REPORT_EMPTY_UPDATE = 'Send status or adminNote';
export const BUG_REPORT_CHANGED =
  'The bug report changed meanwhile; reload it and try again';
export const BUG_REPORT_LIMITED = 'Too many bug reports; try again later';
export const SCREENSHOT_LIMITED =
  'Too many screenshot uploads; try again later or send the report without a screenshot';

const SCREENSHOT_FILE = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;

@Injectable()
export class BugReportsService {
  constructor(
    private readonly reports: BugReportsRepository,
    private readonly storage: PrivateStorageClient,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async screenshotUploadUrl(
    authUserId: string,
    dto: ScreenshotUploadUrlDto,
  ): Promise<ScreenshotUploadUrl> {
    const key = storageKeys.bugReportScreenshot(
      authUserId,
      randomUUID(),
      SCREENSHOT_EXTENSIONS[dto.contentType],
    );
    if (
      await this.reports.issueScreenshot(authUserId, key, SCREENSHOT_LIMITS)
    ) {
      throw new HttpException(SCREENSHOT_LIMITED, HttpStatus.TOO_MANY_REQUESTS);
    }
    const { url, expiresAt } = await this.storage.presignPut(key, {
      contentType: dto.contentType,
      contentLength: dto.contentLength,
    });
    return { uploadUrl: url, key, expiresAt };
  }

  async submit(
    user: SupabaseJwtPayload,
    dto: SubmitBugReportDto,
  ): Promise<{ id: string; createdAt: string }> {
    if (dto.screenshotKey !== undefined) {
      await this.checkScreenshot(user.sub, dto.screenshotKey);
    }
    const report: NewBugReport = {
      reporter_id: user.sub,
      reporter_name: (
        (await this.reports.instructorName(user.sub)) ??
        user.email ??
        user.sub
      ).slice(0, 200),
      reporter_email: user.email ?? null,
      reporter_role:
        user.app_metadata?.role === 'admin' ? 'admin' : 'instructor',
      description: dto.description,
      expected: dto.expected ?? null,
      severity: dto.severity ?? null,
      page_url: dto.pageUrl,
      app_version: dto.appVersion ?? null,
      viewport: dto.viewport ?? null,
      user_agent: dto.userAgent ?? null,
      screenshot_key: dto.screenshotKey ?? null,
    };
    const outcome = await this.reports.submit(report, BUG_REPORT_LIMITS);
    if ('limited' in outcome) {
      throw new HttpException(BUG_REPORT_LIMITED, HttpStatus.TOO_MANY_REQUESTS);
    }
    this.notify(outcome.id, report);
    return outcome;
  }

  async list(
    query: BugReportsQueryDto,
  ): Promise<{ items: BugReportItem[]; total: number }> {
    const limit = query.limit ?? BUG_REPORT_DEFAULT_LIMIT;
    const { rows, total } = await this.reports.list(query.status, {
      limit,
      offset: pageOffset(query.page ?? 1, limit),
    });
    return { items: rows.map(toItem), total };
  }

  async detail(id: string): Promise<BugReportDetail> {
    return this.present(await this.find(id));
  }

  async update(
    id: string,
    dto: UpdateBugReportDto,
    actor: AuditActor,
  ): Promise<BugReportDetail> {
    if (dto.status === undefined && dto.adminNote === undefined) {
      throw new BadRequestException(BUG_REPORT_EMPTY_UPDATE);
    }
    const current = await this.find(id);
    const updated = await this.reports.update(id, current.status, {
      status: dto.status,
      admin_note: dto.adminNote,
    });
    if (!updated) {
      throw new ConflictException(BUG_REPORT_CHANGED);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.bugReportUpdate,
      actor,
      targetType: 'bug_report',
      targetId: id,
      metadata: {
        fromStatus: current.status,
        toStatus: updated.status,
        adminNoteChanged: current.admin_note !== updated.admin_note,
      },
    });
    return this.present(updated);
  }

  private async find(id: string): Promise<BugReportRow> {
    const row = await this.reports.findById(id);
    if (!row) {
      throw new NotFoundException(BUG_REPORT_NOT_FOUND);
    }
    return row;
  }

  private async present(row: BugReportRow): Promise<BugReportDetail> {
    const screenshot = row.screenshot_key
      ? await this.storage.presignGet(row.screenshot_key)
      : null;
    return {
      ...toItem(row),
      appVersion: row.app_version,
      viewport: row.viewport,
      userAgent: row.user_agent,
      adminNote: row.admin_note,
      updatedAt: row.updated_at,
      screenshotUrl: screenshot?.url ?? null,
    };
  }

  private async checkScreenshot(
    authUserId: string,
    key: string,
  ): Promise<void> {
    const prefix = storageKeys.bugReportScreenshots(authUserId);
    if (
      !key.startsWith(prefix) ||
      !SCREENSHOT_FILE.test(key.slice(prefix.length))
    ) {
      throw new BadRequestException(SCREENSHOT_NOT_YOURS);
    }
    const head = await this.storage.head(key);
    if (!head) {
      throw new BadRequestException(SCREENSHOT_MISSING);
    }
    if (
      !SCREENSHOT_CONTENT_TYPES.some((type) => type === head.contentType) ||
      head.contentLength < 1 ||
      head.contentLength > MAX_SCREENSHOT_BYTES
    ) {
      throw new BadRequestException(SCREENSHOT_INVALID);
    }
  }

  private notify(id: string, report: NewBugReport): void {
    const to = readOptional(this.config, 'BUG_REPORT_EMAIL');
    if (!to) {
      return;
    }
    const lines = [
      report.description,
      ...(report.expected ? ['', 'Expected:', report.expected] : []),
      '',
      `Reporter: ${report.reporter_name} (${report.reporter_role})`,
      `Page: ${report.page_url}`,
      `Open: ${this.mailer.portalLink(`/admin/bug-reports/${id}`)}`,
    ];
    void this.mailer.sendText({
      kind: 'admin.bug_report',
      to,
      subject: `[SSMS] ${report.severity ?? 'report'}: ${cleanLine(report.description).slice(0, 60)}`,
      text: lines.join('\n'),
      metadata: { bugReportId: id },
    });
  }
}

function toItem(row: BugReportRow): BugReportItem {
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    severity: row.severity,
    description: row.description,
    expected: row.expected,
    reporter: {
      id: row.reporter_id,
      name: row.reporter_name,
      email: row.reporter_email,
      role: row.reporter_role,
    },
    pageUrl: row.page_url,
    hasScreenshot: row.screenshot_key !== null,
  };
}
