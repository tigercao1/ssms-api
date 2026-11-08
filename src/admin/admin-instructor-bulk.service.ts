import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { isUUID, validate, type ValidationError } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import type { UpdateInstructorProfileDto } from '../instructors/dto/update-instructor-profile.dto';
import type { InstructorProfile } from '../instructors/instructors.types';
import { AdminService, approvalTransitionError } from './admin.service';
import {
  BulkInstructorUpdateRowDto,
  type BulkUpdateInstructorsDto,
} from './dto/bulk-update-instructors.dto';

export const ATOMIC_NOT_APPLIED =
  'Not applied: another row failed and the request is atomic';
export const UPDATE_FAILED = 'The update could not be saved';
export const MAX_STATUS_ROWS = 25;

const PROFILE_FIELDS = [
  'displayNameEn',
  'firstName',
  'lastName',
  'displayNameZh',
  'bioEn',
  'bioZh',
  'dateOfBirth',
  'preferredLanguage',
  'profilePhotoUrl',
  'minStudentAge',
  'teachingLocationIds',
  'languageIds',
  'courseLevelOfferedIds',
  'certifications',
  'trainerStatus',
] as const satisfies readonly (keyof UpdateInstructorProfileDto)[];

type ProfileField = (typeof PROFILE_FIELDS)[number];

const REFUSED_FIELDS: Record<string, string> = {
  email:
    'email cannot be changed in bulk; use PATCH /admin/instructors/:id/email from a signed-in session',
  role: 'role cannot be changed here; use PATCH /admin/users/:id/role from a signed-in session',
};

export type BulkRowStatus = 'updated' | 'unchanged' | 'failed';

export interface BulkInstructorRowResult {
  id: string;
  status: BulkRowStatus;
  changes?: string[];
  error?: string;
}

export interface BulkUpdateInstructorsResult {
  results: BulkInstructorRowResult[];
  summary: Record<BulkRowStatus, number>;
}

interface RowChanges {
  profile: UpdateInstructorProfileDto;
  profileFields: ProfileField[];
  displayOrder?: { to: number | null };
  approval?: { to: 'approved' | 'rejected'; reason?: string };
  isActive?: { to: boolean };
}

interface RowPlan {
  id: string;
  fields: string[];
  changes?: RowChanges;
  error?: string;
}

@Injectable()
export class AdminInstructorBulkService {
  private readonly logger = new Logger(AdminInstructorBulkService.name);

  constructor(
    private readonly admin: AdminService,
    private readonly audit: AuditService,
  ) {}

  async update(
    dto: BulkUpdateInstructorsDto,
    actor: AuditActor,
  ): Promise<BulkUpdateInstructorsResult> {
    const ids = uniqueIds(dto.updates);
    assertStatusRowCap(dto.updates);
    const plans: RowPlan[] = [];
    for (const [index, row] of dto.updates.entries()) {
      plans.push(await this.plan(row, ids[index]));
    }
    const atomic = dto.atomic ?? false;
    const dryRun = dto.dryRun ?? false;
    let results: BulkInstructorRowResult[];
    if (atomic && plans.some((plan) => plan.error)) {
      results = plans.map((plan) =>
        plan.error || !plan.fields.length
          ? preview(plan)
          : {
              id: plan.id,
              status: 'failed',
              changes: plan.fields,
              error: ATOMIC_NOT_APPLIED,
            },
      );
    } else if (dryRun) {
      results = plans.map(preview);
    } else {
      results = await this.applyAll(plans, actor, atomic);
    }
    const summary = summarize(results);
    if (!dryRun) {
      await this.audit.record({
        action: AUDIT_ACTIONS.instructorsBulkUpdate,
        actor: { ...actor, role: 'admin' },
        targetType: 'instructor',
        targetId: null,
        metadata: {
          atomic,
          rows: results.length,
          ...summary,
          instructors: results
            .filter((result) => result.changes?.length)
            .map(({ id, status, changes }) => ({ id, status, changes })),
        },
      });
    }
    return { results, summary };
  }

  private async plan(
    raw: BulkInstructorUpdateRowDto,
    id: string,
  ): Promise<RowPlan> {
    const refused = Object.keys(REFUSED_FIELDS)
      .filter((field) => field in raw)
      .map((field) => REFUSED_FIELDS[field]);
    if (refused.length) {
      return { id, fields: [], error: refused.join('; ') };
    }
    const row = plainToInstance(BulkInstructorUpdateRowDto, raw);
    const invalid = await validate(row, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (invalid.length) {
      return { id, fields: [], error: messages(invalid).join('; ') };
    }
    if (row.reason !== undefined && row.approvalStatus === undefined) {
      return {
        id,
        fields: [],
        error: 'reason is only accepted with approvalStatus',
      };
    }
    try {
      return { id, ...(await this.diff(row, id)) };
    } catch (err) {
      return { id, fields: [], error: this.errorMessage(err) };
    }
  }

  private async diff(
    row: BulkInstructorUpdateRowDto,
    id: string,
  ): Promise<Omit<RowPlan, 'id'>> {
    const current = await this.admin.getInstructor(id);
    const sent = PROFILE_FIELDS.filter((field) => row[field] !== undefined);
    const profile = sent.length
      ? await this.admin.getInstructorProfile(id)
      : undefined;
    const profileFields = profile
      ? sent.filter((field) => profileFieldChanged(field, row, profile))
      : [];
    const changes: RowChanges = {
      profile: Object.fromEntries(
        profileFields.map((field) => [field, row[field]]),
      ),
      profileFields,
    };
    const fields: string[] = [...profileFields];
    if (
      row.displayOrder !== undefined &&
      row.displayOrder !== current.displayOrder
    ) {
      changes.displayOrder = { to: row.displayOrder };
      fields.push('displayOrder');
    }
    if (
      row.approvalStatus !== undefined &&
      row.approvalStatus !== current.approvalStatus
    ) {
      const error = approvalTransitionError(
        current.approvalStatus,
        row.approvalStatus,
      );
      if (error) {
        return { fields: [], error };
      }
      changes.approval = { to: row.approvalStatus, reason: row.reason };
      fields.push('approvalStatus');
    }
    if (row.isActive !== undefined && row.isActive !== current.isActive) {
      changes.isActive = { to: row.isActive };
      fields.push('isActive');
    }
    return { fields, changes };
  }

  private async applyAll(
    plans: RowPlan[],
    actor: AuditActor,
    atomic: boolean,
  ): Promise<BulkInstructorRowResult[]> {
    const results: BulkInstructorRowResult[] = [];
    let halted = false;
    for (const plan of plans) {
      if (plan.error || !plan.changes || !plan.fields.length) {
        results.push(preview(plan));
      } else if (halted) {
        results.push({
          id: plan.id,
          status: 'failed',
          changes: plan.fields,
          error: ATOMIC_NOT_APPLIED,
        });
      } else {
        const result = await this.apply(plan.id, plan.changes, actor);
        halted = atomic && result.status === 'failed';
        results.push(result);
      }
    }
    return results;
  }

  private async apply(
    id: string,
    changes: RowChanges,
    actor: AuditActor,
  ): Promise<BulkInstructorRowResult> {
    const applied: string[] = [];
    try {
      if (changes.profileFields.length) {
        await this.admin.updateProfile(id, changes.profile);
        applied.push(...changes.profileFields);
      }
      if (changes.displayOrder) {
        await this.admin.setDisplayOrder(id, changes.displayOrder.to, actor);
        applied.push('displayOrder');
      }
      if (changes.approval) {
        await this.admin.setApprovalStatus(
          id,
          changes.approval.to,
          changes.approval.reason,
          actor,
        );
        applied.push('approvalStatus');
      }
      if (changes.isActive) {
        await this.admin.setActive(id, changes.isActive.to, actor);
        applied.push('isActive');
      }
      return { id, status: 'updated', changes: applied };
    } catch (err) {
      const message = this.errorMessage(err);
      return {
        id,
        status: 'failed',
        changes: applied,
        error: applied.length
          ? `${message} (already applied: ${applied.join(', ')})`
          : message,
      };
    }
  }

  private errorMessage(err: unknown): string {
    if (err instanceof HttpException) {
      return httpMessage(err);
    }
    this.logger.error(
      'Bulk instructor update row failed',
      err instanceof Error ? err.stack : String(err),
    );
    return UPDATE_FAILED;
  }
}

function uniqueIds(rows: BulkInstructorUpdateRowDto[]): string[] {
  const seen = new Set<string>();
  return rows.map((row, index) => {
    if (typeof row.id !== 'string' || !isUUID(row.id, '4')) {
      throw new BadRequestException(`updates.${index}.id must be a UUID`);
    }
    const id = row.id.toLowerCase();
    if (seen.has(id)) {
      throw new BadRequestException(
        `updates.${index}.id ${id} appears more than once; send each instructor once`,
      );
    }
    seen.add(id);
    return id;
  });
}

function assertStatusRowCap(rows: BulkInstructorUpdateRowDto[]): void {
  const statusRows = rows.filter(
    (row) => row.approvalStatus !== undefined || row.isActive !== undefined,
  ).length;
  if (statusRows > MAX_STATUS_ROWS) {
    throw new BadRequestException(
      `At most ${MAX_STATUS_ROWS} rows per request may set approvalStatus or isActive (got ${statusRows}); split the request`,
    );
  }
}

function preview(plan: RowPlan): BulkInstructorRowResult {
  if (plan.error) {
    return { id: plan.id, status: 'failed', error: plan.error };
  }
  return plan.fields.length
    ? { id: plan.id, status: 'updated', changes: plan.fields }
    : { id: plan.id, status: 'unchanged' };
}

function summarize(
  results: BulkInstructorRowResult[],
): Record<BulkRowStatus, number> {
  const count = (status: BulkRowStatus) =>
    results.filter((result) => result.status === status).length;
  return {
    updated: count('updated'),
    unchanged: count('unchanged'),
    failed: count('failed'),
  };
}

function sameIds(next: string[] | undefined, current: { id: string }[]) {
  return sameSet(
    next ?? [],
    current.map((row) => row.id),
  );
}

function sameSet(next: string[], current: string[]): boolean {
  return (
    JSON.stringify([...next].sort()) === JSON.stringify([...current].sort())
  );
}

function certificationKey(cert: {
  org: string;
  track: string;
  level: number;
  isPartial?: boolean;
  partialComponents?: string[];
  achievedOn?: string | null;
}): string {
  return JSON.stringify([
    cert.org,
    cert.track,
    cert.level,
    cert.isPartial ?? false,
    [...(cert.partialComponents ?? [])].sort(),
    cert.achievedOn ?? null,
  ]);
}

function trainerKey(trainer: {
  discipline: string;
  rookieSessionCompleted?: boolean;
  trainerExamPassed?: boolean;
  trainerLevel?: number | null;
}): string {
  return JSON.stringify([
    trainer.discipline,
    trainer.rookieSessionCompleted ?? false,
    trainer.trainerExamPassed ?? false,
    trainer.trainerLevel ?? null,
  ]);
}

function profileFieldChanged(
  field: ProfileField,
  row: BulkInstructorUpdateRowDto,
  profile: InstructorProfile,
): boolean {
  switch (field) {
    case 'firstName':
    case 'lastName':
      return row[field]?.trim() !== profile[field];
    case 'bioEn':
    case 'bioZh':
      return (row[field] ?? '') !== (profile[field] ?? '');
    case 'teachingLocationIds':
      return !sameIds(row.teachingLocationIds, profile.teachingLocations);
    case 'languageIds':
      return !sameIds(row.languageIds, profile.languages);
    case 'courseLevelOfferedIds':
      return !sameIds(row.courseLevelOfferedIds, profile.courseLevelsOffered);
    case 'certifications':
      return !sameSet(
        (row.certifications ?? []).map(certificationKey),
        profile.certifications.map(certificationKey),
      );
    case 'trainerStatus':
      return !sameSet(
        (row.trainerStatus ?? []).map(trainerKey),
        profile.trainerStatus.map(trainerKey),
      );
    default:
      return (row[field] ?? null) !== profile[field];
  }
}

function messages(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    return [
      ...Object.values(error.constraints ?? {}).map((message) =>
        parent ? `${parent}.${message}` : message,
      ),
      ...messages(error.children ?? [], path),
    ];
  });
}

function httpMessage(err: HttpException): string {
  const body = err.getResponse();
  if (typeof body === 'string') {
    return body;
  }
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) {
    return message.join('; ');
  }
  return typeof message === 'string' ? message : err.message;
}
