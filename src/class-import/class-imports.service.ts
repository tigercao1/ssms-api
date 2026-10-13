import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { hasCode } from '../database/db-result';
import {
  ClassImportCsvError,
  type ParsedImportRow,
  parseImportCsv,
  rowFields,
} from './class-import-csv';
import {
  duplicateRowNos,
  emailKey,
  isBlocked,
  type MatchContext,
  type MatchedRow,
  type MatchInput,
  matchRow,
  matchRows,
  phoneKey,
  summarize,
} from './class-import-matching';
import {
  type ClassImport,
  type ClassImportDetail,
  type ClassImportRowView,
  type CommitCounts,
  type CommitResult,
  type EventMapResult,
  type EventMapping,
  type EventNameSummary,
  type ManualField,
  type RowFilter,
} from './class-import.types';
import {
  ClassImportsRepository,
  type ImportRecord,
  type ImportRowRecord,
  MAX_IMPORTS_LISTED,
} from './class-imports.repository';

export const IMPORT_NOT_FOUND = 'Class import not found';
export const IMPORT_ROW_NOT_FOUND = 'Class import row not found';
export const IMPORT_NOT_DRAFT = 'This import is no longer a draft';
export const IMPORT_FILE_REQUIRED = 'Upload a CSV file in the `file` field';
export const IMPORT_FILE_NOT_UTF8 = 'The file is not UTF-8 text';
export const IMPORT_INSTRUCTOR_NOT_FOUND = 'Instructor not found';
export const IMPORT_LESSON_TYPE_NOT_FOUND = 'Lesson type not found';
export const IMPORT_CUSTOMER_NOT_FOUND = 'Customer not found';
export const IMPORT_NOTHING_TO_UPDATE = 'Nothing to update';
export const IMPORT_DUPLICATE_EVENT_NAME =
  'Each event name may appear only once';
export const MAX_FILENAME_LENGTH = 255;

const POSTGRES_NO_DATA_FOUND = 'P0002';
const POSTGRES_OBJECT_NOT_IN_STATE = '55000';

export interface UploadedCsv {
  originalname?: string;
  size: number;
  buffer: Buffer;
}

export interface RowPatch {
  instructorId?: string;
  lessonTypeId?: string;
  customerId?: string | null;
}

export interface EventMapPatch {
  eventName: string;
  lessonTypeId: string | null;
}

function toImport(record: ImportRecord): ClassImport {
  return {
    id: record.id,
    filename: record.filename,
    status: record.status,
    counts: record.counts,
    uploadedBy: record.uploaded_by,
    committedAt: record.committed_at,
    createdAt: record.created_at,
  };
}

function toMatchInput(record: ImportRowRecord): MatchInput {
  return {
    rowNo: record.row_no,
    externalId: record.external_id,
    raw: record.raw,
    instructorId: record.instructor_id,
    lessonTypeId: record.lesson_type_id,
    customerId: record.customer_id,
    manualFields: record.manual_fields ?? [],
    classId: record.class_id,
  };
}

function toRecord(importId: string, row: MatchedRow): ImportRowRecord {
  return {
    import_id: importId,
    row_no: row.rowNo,
    external_id: row.externalId,
    raw: row.raw,
    event_name: row.eventName,
    instructor_name: row.instructorName,
    instructor_id: row.instructorId,
    lesson_type_id: row.lessonTypeId,
    customer_id: row.customerId,
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    status_to_set: row.statusToSet,
    problems: row.problems,
    manual_fields: row.manualFields,
    class_id: row.classId,
  };
}

function matchesFilter(row: ImportRowRecord, filter?: RowFilter): boolean {
  if (!filter) {
    return true;
  }
  if (filter === 'any') {
    return row.problems.length > 0;
  }
  if (filter === 'blocking') {
    return isBlocked(row.problems);
  }
  return row.problems.includes(filter);
}

function filename(file: UploadedCsv): string {
  const name = (file.originalname ?? '').trim();
  return (name === '' ? 'import.csv' : name).slice(0, MAX_FILENAME_LENGTH);
}

function decode(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new BadRequestException(IMPORT_FILE_NOT_UTF8);
  }
}

@Injectable()
export class ClassImportsService {
  constructor(
    private readonly repo: ClassImportsRepository,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<ClassImport[]> {
    return (await this.repo.listImports(MAX_IMPORTS_LISTED)).map(toImport);
  }

  async upload(
    file: UploadedCsv | undefined,
    actor: AuditActor,
  ): Promise<ClassImportDetail> {
    if (!file?.buffer || file.size === 0) {
      throw new BadRequestException(IMPORT_FILE_REQUIRED);
    }
    let parsed: ParsedImportRow[];
    try {
      parsed = parseImportCsv(decode(file.buffer));
    } catch (err) {
      if (err instanceof ClassImportCsvError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
    const inputs: MatchInput[] = parsed.map((row) => ({
      ...row,
      instructorId: null,
      lessonTypeId: null,
      customerId: null,
      manualFields: [],
      classId: null,
    }));
    const matched = matchRows(inputs, await this.context(inputs));
    const summary = summarize(matched);
    const created = await this.repo.createImport({
      filename: filename(file),
      uploaded_by: actor.userId ?? null,
      counts: { ...summary },
    });
    try {
      await this.repo.saveRows(matched.map((r) => toRecord(created.id, r)));
    } catch (err) {
      await this.repo.deleteImport(created.id);
      throw err;
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.classImportCreate,
      actor,
      targetType: 'class_import',
      targetId: created.id,
      metadata: { ...summary },
    });
    return this.detail(created);
  }

  async get(id: string, filter?: RowFilter): Promise<ClassImportDetail> {
    return this.detail(await this.load(id), filter);
  }

  async updateRow(
    id: string,
    rowNo: number,
    patch: RowPatch,
    actor: AuditActor,
  ): Promise<ClassImportDetail> {
    if (
      patch.instructorId === undefined &&
      patch.lessonTypeId === undefined &&
      patch.customerId === undefined
    ) {
      throw new BadRequestException(IMPORT_NOTHING_TO_UPDATE);
    }
    const record = await this.loadDraft(id);
    const rows = await this.repo.listRows(id);
    const target = rows.find((r) => r.row_no === rowNo);
    if (!target) {
      throw new NotFoundException(IMPORT_ROW_NOT_FOUND);
    }
    await this.assertExists(
      'instructors',
      patch.instructorId,
      IMPORT_INSTRUCTOR_NOT_FOUND,
    );
    await this.assertExists(
      'lesson_types',
      patch.lessonTypeId,
      IMPORT_LESSON_TYPE_NOT_FOUND,
    );
    await this.assertExists(
      'customers',
      patch.customerId ?? undefined,
      IMPORT_CUSTOMER_NOT_FOUND,
    );

    const input = toMatchInput(target);
    const manual = new Set<ManualField>(input.manualFields);
    if (patch.instructorId !== undefined) {
      input.instructorId = patch.instructorId;
      manual.add('instructor');
    }
    if (patch.lessonTypeId !== undefined) {
      input.lessonTypeId = patch.lessonTypeId;
      manual.add('lesson_type');
    }
    if (patch.customerId !== undefined) {
      input.customerId = patch.customerId;
      manual.add('customer');
    }
    input.manualFields = [...manual];

    const duplicate = duplicateRowNos(rows.map(toMatchInput)).has(rowNo);
    const updated = toRecord(
      id,
      matchRow(input, await this.context([input]), duplicate),
    );
    await this.repo.saveRows([updated]);
    const merged = rows.map((r) => (r.row_no === rowNo ? updated : r));
    const summary = summarize(merged.map(this.summaryShape));
    await this.repo.updateCounts(id, { ...summary });
    await this.audit.record({
      action: AUDIT_ACTIONS.classImportRowUpdate,
      actor,
      targetType: 'class_import',
      targetId: id,
      metadata: {
        rowNo,
        fields: Object.keys(patch).filter(
          (k) => patch[k as keyof RowPatch] !== undefined,
        ),
        blocked: isBlocked(updated.problems),
      },
    });
    return this.detail(
      { ...record, counts: { ...summary } },
      undefined,
      merged,
    );
  }

  async eventMap(): Promise<EventMapping[]> {
    return (await this.repo.eventMap()).map((m) => ({
      eventName: m.event_name,
      lessonTypeId: m.lesson_type_id,
    }));
  }

  async setEventMap(
    patches: EventMapPatch[],
    actor: AuditActor,
  ): Promise<EventMapResult> {
    const names = patches.map((p) => p.eventName.trim());
    if (new Set(names).size !== names.length) {
      throw new BadRequestException(IMPORT_DUPLICATE_EVENT_NAME);
    }
    const upserts = patches
      .filter((p) => p.lessonTypeId !== null)
      .map((p) => ({
        event_name: p.eventName.trim(),
        lesson_type_id: p.lessonTypeId as string,
      }));
    const removals = patches
      .filter((p) => p.lessonTypeId === null)
      .map((p) => p.eventName.trim());
    await this.assertAllExist(
      'lesson_types',
      upserts.map((u) => u.lesson_type_id),
      IMPORT_LESSON_TYPE_NOT_FOUND,
    );
    await this.repo.saveEventMap(upserts, removals, actor.userId ?? null);

    const drafts = await this.repo.draftIds();
    for (const draftId of drafts) {
      await this.rematch(draftId);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.classImportEventMapUpdate,
      actor,
      targetType: 'class_import',
      targetId: null,
      metadata: {
        set: upserts.length,
        removed: removals.length,
        rematchedImports: drafts.length,
      },
    });
    return { mappings: await this.eventMap(), rematchedImports: drafts.length };
  }

  async commit(id: string, actor: AuditActor): Promise<CommitResult> {
    await this.loadDraft(id);
    let counts: CommitCounts;
    try {
      counts = await this.repo.commit(id, actor.userId ?? null);
    } catch (err) {
      if (hasCode(err, POSTGRES_NO_DATA_FOUND)) {
        throw new NotFoundException(IMPORT_NOT_FOUND);
      }
      if (hasCode(err, POSTGRES_OBJECT_NOT_IN_STATE)) {
        throw new ConflictException(IMPORT_NOT_DRAFT);
      }
      throw err;
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.classImportCommit,
      actor,
      targetType: 'class_import',
      targetId: id,
      metadata: { ...counts },
    });
    return { import: toImport(await this.load(id)), counts };
  }

  async discard(id: string, actor: AuditActor): Promise<ClassImport> {
    await this.load(id);
    const discarded = await this.repo.discardDraft(id);
    if (!discarded) {
      throw new ConflictException(IMPORT_NOT_DRAFT);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.classImportDiscard,
      actor,
      targetType: 'class_import',
      targetId: id,
      metadata: null,
    });
    return toImport(discarded);
  }

  private summaryShape(this: void, r: ImportRowRecord) {
    return {
      problems: r.problems,
      statusToSet: r.status_to_set,
      classId: r.class_id,
    };
  }

  private async load(id: string): Promise<ImportRecord> {
    const record = await this.repo.getImport(id);
    if (!record) {
      throw new NotFoundException(IMPORT_NOT_FOUND);
    }
    return record;
  }

  private async loadDraft(id: string): Promise<ImportRecord> {
    const record = await this.load(id);
    if (record.status !== 'draft') {
      throw new ConflictException(IMPORT_NOT_DRAFT);
    }
    return record;
  }

  private async rematch(id: string): Promise<void> {
    const inputs = (await this.repo.listRows(id)).map(toMatchInput);
    const matched = matchRows(inputs, await this.context(inputs));
    await this.repo.saveRows(matched.map((r) => toRecord(id, r)));
    await this.repo.updateCounts(id, { ...summarize(matched) });
  }

  private async context(rows: MatchInput[]): Promise<MatchContext> {
    const fields = rows.map((r) => rowFields(r.raw));
    const emails = [
      ...new Set(
        fields.map((f) => emailKey(f.email)).filter((k) => k !== null),
      ),
    ];
    const phones = [
      ...new Set(
        fields.map((f) => phoneKey(f.phone)).filter((k) => k !== null),
      ),
    ];
    const [instructors, calendars, eventMap, customers, imported] =
      await Promise.all([
        this.repo.instructors(),
        this.repo.calendars(),
        this.repo.eventMap(),
        this.repo.findCustomers(emails, phones),
        this.repo.importedExternalIds(rows.map((r) => r.externalId)),
      ]);
    return {
      instructors,
      calendars,
      eventMap: new Map(eventMap.map((m) => [m.event_name, m.lesson_type_id])),
      customers,
      importedExternalIds: new Set(imported),
      now: new Date(),
    };
  }

  private async detail(
    record: ImportRecord,
    filter?: RowFilter,
    preloaded?: ImportRowRecord[],
  ): Promise<ClassImportDetail> {
    const rows = preloaded ?? (await this.repo.listRows(record.id));
    const [instructors, eventMap, customers] = await Promise.all([
      this.repo.instructors(),
      this.repo.eventMap(),
      this.repo.customerNames(
        rows.map((r) => r.customer_id).filter((v): v is string => v !== null),
      ),
    ]);
    const instructorNames = new Map(
      instructors.map((i) => [i.id, i.displayNameEn]),
    );
    const customerNames = new Map(
      customers.map((c) => [
        c.id,
        [c.first_name, c.last_name].filter((p) => p).join(' ') || null,
      ]),
    );
    const mapping = new Map(
      eventMap.map((m) => [m.event_name, m.lesson_type_id]),
    );
    const events = new Map<string, number>();
    for (const row of rows) {
      if (row.event_name) {
        events.set(row.event_name, (events.get(row.event_name) ?? 0) + 1);
      }
    }
    const eventNames: EventNameSummary[] = [...events.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([eventName, count]) => ({
        eventName,
        rows: count,
        lessonTypeId: mapping.get(eventName) ?? null,
      }));
    return {
      import: toImport(record),
      summary: summarize(rows.map(this.summaryShape)),
      eventNames,
      rows: rows
        .filter((r) => matchesFilter(r, filter))
        .map((r) => this.toView(r, instructorNames, customerNames)),
    };
  }

  private toView(
    row: ImportRowRecord,
    instructorNames: Map<string, string>,
    customerNames: Map<string, string | null>,
  ): ClassImportRowView {
    const fields = rowFields(row.raw);
    return {
      rowNo: row.row_no,
      externalId: row.external_id,
      eventName: row.event_name,
      instructorName: row.instructor_name,
      customerName: fields.customerName,
      customerEmail: fields.email,
      customerPhone: fields.phone,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      statusToSet: row.status_to_set,
      instructorId: row.instructor_id,
      matchedInstructorName: row.instructor_id
        ? (instructorNames.get(row.instructor_id) ?? null)
        : null,
      lessonTypeId: row.lesson_type_id,
      customerId: row.customer_id,
      matchedCustomerName: row.customer_id
        ? (customerNames.get(row.customer_id) ?? null)
        : null,
      problems: row.problems,
      manualFields: row.manual_fields ?? [],
      classId: row.class_id,
    };
  }

  private async assertExists(
    table: 'instructors' | 'lesson_types' | 'customers',
    id: string | undefined,
    message: string,
  ): Promise<void> {
    if (id !== undefined) {
      await this.assertAllExist(table, [id], message);
    }
  }

  private async assertAllExist(
    table: 'instructors' | 'lesson_types' | 'customers',
    ids: string[],
    message: string,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const found = new Set(await this.repo.existingIds(table, ids));
    if (ids.some((id) => !found.has(id))) {
      throw new BadRequestException(message);
    }
  }
}
