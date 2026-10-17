import { randomUUID } from 'node:crypto';
import { DocumentExportsRepository } from '../../src/documents/document-exports.repository';
import type {
  DocumentExportRow,
  DocumentExportStatus,
  DocumentExportWrite,
  NewDocumentExportRow,
  TemplateAssignmentDbRow,
  TemplateAssignmentQuery,
} from '../../src/documents/document-exports.types';
import type {
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
} from './documents-fakes';

let clock = Date.parse('2026-10-10T00:00:00Z');
function nextTimestamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function likeToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      source += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    } else if (c === '%') {
      source += '.*';
    } else if (c === '_') {
      source += '.';
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'is');
}

/** A `document_exports` row with defaults. */
export function documentExportRow(
  overrides: Partial<DocumentExportRow> &
    Pick<DocumentExportRow, 'template_id'>,
): DocumentExportRow {
  const now = nextTimestamp();
  return {
    id: randomUUID(),
    season: null,
    assignment_ids: null,
    status: 'queued',
    file_count: null,
    skipped_count: null,
    size_bytes: null,
    zip_key: null,
    error: null,
    requested_by: randomUUID(),
    started_at: null,
    finished_at: null,
    expires_at: null,
    inserted_at: now,
    updated_at: now,
    ...overrides,
  };
}

/**
 * In-memory `document_exports`, with `listTemplateAssignments` mirroring the
 * SQL function over the in-memory assignments and instructors.
 */
export class InMemoryDocumentExportsRepository extends DocumentExportsRepository {
  readonly rows = new Map<string, DocumentExportRow>();
  readonly assignmentQueries: TemplateAssignmentQuery[] = [];

  constructor(
    private readonly assignments: InMemoryDocumentAssignmentsRepository,
    private readonly subjects: InMemoryDocumentSubjectsRepository,
  ) {
    super();
  }

  seed(
    overrides: Partial<DocumentExportRow> &
      Pick<DocumentExportRow, 'template_id'>,
  ): DocumentExportRow {
    const row = documentExportRow(overrides);
    this.rows.set(row.id, row);
    return row;
  }

  insert(row: NewDocumentExportRow): Promise<DocumentExportRow> {
    return Promise.resolve(this.seed(row));
  }

  findById(id: string): Promise<DocumentExportRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  listForTemplate(
    templateId: string,
    limit: number,
  ): Promise<DocumentExportRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.template_id === templateId)
        .sort((a, b) => b.inserted_at.localeCompare(a.inserted_at))
        .slice(0, limit),
    );
  }

  updateIfStatus(
    id: string,
    statuses: DocumentExportStatus[],
    patch: DocumentExportWrite,
  ): Promise<DocumentExportRow | null> {
    const row = this.rows.get(id);
    if (!row || !statuses.includes(row.status)) {
      return Promise.resolve(null);
    }
    const next = { ...row, ...patch, updated_at: nextTimestamp() };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  failUnfinished(error: string, at: string): Promise<number> {
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.status === 'queued' || row.status === 'running') {
        this.rows.set(row.id, {
          ...row,
          status: 'failed',
          error,
          finished_at: at,
        });
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  listExpired(now: string): Promise<DocumentExportRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (r) =>
          r.status === 'ready' && r.expires_at !== null && r.expires_at <= now,
      ),
    );
  }

  listTemplateAssignments(
    query: TemplateAssignmentQuery,
  ): Promise<TemplateAssignmentDbRow[]> {
    this.assignmentQueries.push(query);
    const patterns = query.patterns.map(likeToRegExp);
    const matching = [...this.assignments.rows.values()]
      .filter(
        (a) =>
          a.template_id === query.templateId &&
          a.subject_type === 'instructor' &&
          a.status !== 'archived' &&
          (query.season === null || a.season === query.season) &&
          (query.status === 'all' ||
            (query.status === 'completed' && a.status === 'completed') ||
            (query.status === 'open' &&
              (a.status === 'assigned' || a.status === 'viewed'))) &&
          (query.ids === null || query.ids.includes(a.id)),
      )
      .map((a) => {
        const i = this.subjects.instructors.get(a.subject_id);
        return {
          id: a.id,
          status: a.status as TemplateAssignmentDbRow['status'],
          season: a.season,
          instructor_id: a.subject_id,
          first_name: i?.first_name ?? null,
          last_name: i?.last_name ?? null,
          email: i?.email ?? null,
          signer_name: a.signer_name,
          signer_email: a.signer_email,
          assigned_at: a.assigned_at,
          viewed_at: a.viewed_at,
          completed_at: a.completed_at,
          signed_sha256: a.signed_sha256,
          signed_key: a.signed_key,
          total_count: 0,
        };
      })
      .filter((row) => {
        const text = [
          row.first_name,
          row.last_name,
          row.email,
          row.signer_name,
          row.signer_email,
        ]
          .filter((v) => v !== null)
          .join(' ');
        return patterns.every((p) => p.test(text));
      })
      .sort(
        (a, b) =>
          Number(b.status === 'completed') - Number(a.status === 'completed') ||
          (b.completed_at ?? '').localeCompare(a.completed_at ?? '') ||
          compareNullsLast(a.last_name, b.last_name) ||
          compareNullsLast(a.first_name, b.first_name) ||
          a.id.localeCompare(b.id),
      );
    return Promise.resolve(
      matching
        .slice(query.offset, query.offset + query.limit)
        .map((row) => ({ ...row, total_count: matching.length })),
    );
  }
}

function compareNullsLast(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a < b ? -1 : 1;
}
