import { DatabaseError } from '../../src/database/db-result';
import {
  BLOCKING_PROBLEMS,
  type ClassImport,
  type CommitCounts,
} from '../../src/class-import/class-import.types';
import type {
  CalendarRef,
  CustomerMatch,
  InstructorRef,
} from '../../src/class-import/class-import-matching';
import {
  emailKey,
  phoneKey,
} from '../../src/class-import/class-import-matching';
import {
  ClassImportsRepository,
  type CustomerNameRecord,
  type EventMapRecord,
  type ImportRecord,
  type ImportRowRecord,
  type LookupTable,
} from '../../src/class-import/class-imports.repository';

export const ANNA_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const BEN_ID = '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
export const PRIVATE_2H_ID = '2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f';
export const GROUP_2H_ID = '3d4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a';
export const MEI_ID = '4e5f6a7b-8c9d-4e0f-8a1b-3c4d5e6f7a8b';

export const IMPORT_HEADER =
  'id,event.name,firstName,lastName,contactEmail,contactPhone,price,quantity,orderId,orderName,availability,date.startDate,date.endDate,date.timezone,shippingAddress,orderProperties,details.orderDetails,internalNotes,createdAt,status';

export interface CsvRowInput {
  id?: string;
  event?: string;
  first?: string;
  last?: string;
  email?: string;
  phone?: string;
  instructor?: string;
  start?: string;
  end?: string;
  notes?: string;
  status?: string;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvLine(row: CsvRowInput = {}): string {
  return [
    row.id ?? '9000001',
    row.event ?? 'Private Lesson 2h',
    row.first ?? 'Test',
    row.last ?? 'Customer',
    row.email ?? 'test.customer@example.com',
    row.phone ?? '',
    '0',
    '1',
    '',
    '',
    row.instructor ?? 'Anna Example',
    row.start ?? '2025-12-20T10:00:00-05:00',
    row.end ?? '2025-12-20T12:00:00-05:00',
    'America/Toronto',
    '',
    '',
    '',
    row.notes ?? '',
    '2025-12-01T00:00:00.000Z',
    row.status ?? '',
  ]
    .map(csvCell)
    .join(',');
}

export function importCsv(rows: CsvRowInput[]): string {
  return `${[IMPORT_HEADER, ...rows.map(csvLine)].join('\n')}\n`;
}

let sequence = 0;
const nextId = () =>
  `00000000-0000-4000-9000-${String(++sequence).padStart(12, '0')}`;

export interface FakeClass {
  id: string;
  importExternalId: string;
  instructorId: string;
  lessonTypeId: string;
  status: string;
  startsAt: string;
}

export class InMemoryClassImportsRepository extends ClassImportsRepository {
  imports: ImportRecord[] = [];
  rows: ImportRowRecord[] = [];
  map: EventMapRecord[] = [];
  instructorRefs: InstructorRef[] = [
    { id: ANNA_ID, displayNameEn: 'Anna Example', displayNameZh: '安娜' },
    { id: BEN_ID, displayNameEn: 'Ben Sample', displayNameZh: null },
  ];
  calendarRefs: CalendarRef[] = [];
  lessonTypeIds = [PRIVATE_2H_ID, GROUP_2H_ID];
  customers: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
  }[] = [
    {
      id: MEI_ID,
      first_name: 'Mei',
      last_name: 'Tester',
      email: 'Mei.Tester@Example.com',
      phone: '+1 (647) 555-0100',
    },
  ];
  classes: FakeClass[] = [];
  participants: { classId: string; customerId: string }[] = [];
  failSaveRows = false;
  commitError: DatabaseError | null = null;

  listImports(limit: number): Promise<ImportRecord[]> {
    return Promise.resolve(
      [...this.imports]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit),
    );
  }

  getImport(id: string): Promise<ImportRecord | null> {
    return Promise.resolve(this.imports.find((i) => i.id === id) ?? null);
  }

  createImport(input: {
    filename: string;
    uploaded_by: string | null;
    counts: ClassImport['counts'];
  }): Promise<ImportRecord> {
    const record: ImportRecord = {
      id: nextId(),
      ...input,
      status: 'draft',
      committed_by: null,
      committed_at: null,
      created_at: new Date(Date.now() + sequence).toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.imports.push(record);
    return Promise.resolve(record);
  }

  deleteImport(id: string): Promise<void> {
    this.imports = this.imports.filter((i) => i.id !== id);
    this.rows = this.rows.filter((r) => r.import_id !== id);
    return Promise.resolve();
  }

  updateCounts(id: string, counts: ClassImport['counts']): Promise<void> {
    const record = this.imports.find((i) => i.id === id);
    if (record) {
      record.counts = counts;
    }
    return Promise.resolve();
  }

  discardDraft(id: string): Promise<ImportRecord | null> {
    const record = this.imports.find(
      (i) => i.id === id && i.status === 'draft',
    );
    if (record) {
      record.status = 'discarded';
    }
    return Promise.resolve(record ?? null);
  }

  draftIds(): Promise<string[]> {
    return Promise.resolve(
      this.imports.filter((i) => i.status === 'draft').map((i) => i.id),
    );
  }

  listRows(importId: string): Promise<ImportRowRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.import_id === importId)
        .sort((a, b) => a.row_no - b.row_no)
        .map((r) => ({ ...r })),
    );
  }

  saveRows(rows: ImportRowRecord[]): Promise<void> {
    if (this.failSaveRows) {
      return Promise.reject(new DatabaseError('save rows', undefined, 'boom'));
    }
    for (const row of rows) {
      const index = this.rows.findIndex(
        (r) => r.import_id === row.import_id && r.row_no === row.row_no,
      );
      if (index >= 0) {
        this.rows[index] = { ...row };
      } else {
        this.rows.push({ ...row });
      }
    }
    return Promise.resolve();
  }

  instructors(): Promise<InstructorRef[]> {
    return Promise.resolve(this.instructorRefs);
  }

  calendars(): Promise<CalendarRef[]> {
    return Promise.resolve(this.calendarRefs);
  }

  eventMap(): Promise<EventMapRecord[]> {
    return Promise.resolve(
      [...this.map].sort((a, b) => a.event_name.localeCompare(b.event_name)),
    );
  }

  saveEventMap(upserts: EventMapRecord[], removals: string[]): Promise<void> {
    for (const entry of upserts) {
      this.map = this.map.filter((m) => m.event_name !== entry.event_name);
      this.map.push({ ...entry });
    }
    this.map = this.map.filter((m) => !removals.includes(m.event_name));
    return Promise.resolve();
  }

  findCustomers(emails: string[], phones: string[]): Promise<CustomerMatch[]> {
    return Promise.resolve(
      this.customers
        .map((c) => ({
          id: c.id,
          emailKey: emailKey(c.email),
          phoneKey: phoneKey(c.phone),
        }))
        .filter(
          (c) =>
            (c.emailKey && emails.includes(c.emailKey)) ||
            (c.phoneKey && phones.includes(c.phoneKey)),
        ),
    );
  }

  customerNames(ids: string[]): Promise<CustomerNameRecord[]> {
    return Promise.resolve(
      this.customers
        .filter((c) => ids.includes(c.id))
        .map((c) => ({
          id: c.id,
          first_name: c.first_name,
          last_name: c.last_name,
        })),
    );
  }

  importedExternalIds(ids: string[]): Promise<string[]> {
    return Promise.resolve(
      this.classes
        .map((c) => c.importExternalId)
        .filter((id) => ids.includes(id)),
    );
  }

  existingIds(table: LookupTable, ids: string[]): Promise<string[]> {
    const known =
      table === 'instructors'
        ? this.instructorRefs.map((i) => i.id)
        : table === 'lesson_types'
          ? this.lessonTypeIds
          : this.customers.map((c) => c.id);
    return Promise.resolve(ids.filter((id) => known.includes(id)));
  }

  commit(id: string, actorId: string | null): Promise<CommitCounts> {
    if (this.commitError) {
      return Promise.reject(this.commitError);
    }
    const record = this.imports.find((i) => i.id === id);
    const rows = this.rows.filter((r) => r.import_id === id);
    const blocking = new Set<string>(BLOCKING_PROBLEMS);
    const ready = rows.filter(
      (r) =>
        r.instructor_id &&
        r.lesson_type_id &&
        r.starts_at &&
        r.status_to_set &&
        !r.problems.some((p) => blocking.has(p)),
    );
    let created = 0;
    let participants = 0;
    for (const row of ready) {
      let existing = this.classes.find(
        (c) => c.importExternalId === row.external_id,
      );
      if (!existing) {
        existing = {
          id: nextId(),
          importExternalId: row.external_id,
          instructorId: row.instructor_id as string,
          lessonTypeId: row.lesson_type_id as string,
          status: row.status_to_set as string,
          startsAt: row.starts_at as string,
        };
        this.classes.push(existing);
        created += 1;
        if (row.customer_id) {
          this.participants.push({
            classId: existing.id,
            customerId: row.customer_id,
          });
          participants += 1;
        }
      }
      row.class_id = existing.id;
    }
    const counts: CommitCounts = {
      total: rows.length,
      ready: ready.length,
      created,
      alreadyImported: ready.length - created,
      participants,
      skipped: rows.length - ready.length,
    };
    if (record) {
      record.status = 'committed';
      record.committed_by = actorId;
      record.committed_at = new Date().toISOString();
      record.counts = { ...record.counts, commit: counts };
    }
    return Promise.resolve(counts);
  }
}
