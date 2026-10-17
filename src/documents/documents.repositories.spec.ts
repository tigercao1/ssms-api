import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { DatabaseError, PG_UNIQUE_VIOLATION } from '../database/db-result';
import {
  DOCUMENT_ASSIGNMENT_COLUMNS,
  SUBJECT_ID_CHUNK,
  SupabaseDocumentAssignmentsRepository,
} from './document-assignments.repository';
import {
  CERTIFICATION_UPLOAD_COLUMNS,
  DOCUMENT_INSTRUCTOR_COLUMNS,
  SupabaseDocumentSubjectsRepository,
} from './document-subjects.repository';
import {
  DOCUMENT_TEMPLATE_COLUMNS,
  SupabaseDocumentTemplatesRepository,
} from './document-templates.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const fail = { data: null, error: { message: 'boom' } };
const ok = (data: unknown) => ({ data, error: null });
const newRow = {
  template_id: ID,
  subject_type: 'instructor' as const,
  subject_id: ID,
  season: '2026-27',
};

describe('SupabaseDocumentTemplatesRepository', () => {
  it('lists, finds, inserts and updates', async () => {
    const row = { id: ID };
    const { client, queries } = recordingSupabase({
      document_templates: [
        ok([row]),
        ok(null),
        ok(row),
        ok(null),
        ok([row]),
        ok(row),
        ok(null),
        ok([row]),
        ok(row),
      ],
    });
    const repo = new SupabaseDocumentTemplatesRepository(client);
    await expect(repo.list()).resolves.toEqual([row]);
    await expect(repo.list()).resolves.toEqual([]);
    await expect(repo.findById(ID)).resolves.toEqual(row);
    await expect(repo.findById(ID)).resolves.toBeNull();
    await expect(repo.listLiveForAll('instructor')).resolves.toEqual([row]);
    await expect(
      repo.insert({ kind: 'sign', audience: 'instructor', title_en: 'A' }),
    ).resolves.toEqual(row);
    await expect(repo.update(ID, { required: false })).resolves.toBeNull();
    await expect(repo.listLiveForAll('instructor', '2026/27')).resolves.toEqual(
      [row],
    );
    await expect(
      repo.updateIfStatus(ID, ['live'], { status: 'retired' }),
    ).resolves.toEqual(row);
    expect(DOCUMENT_TEMPLATE_COLUMNS).not.toContain('is_active');
    expect(queries[0].ops).toEqual([
      ['select', DOCUMENT_TEMPLATE_COLUMNS],
      ['order', 'sort_order', { ascending: true }],
      ['order', 'title_en', { ascending: true }],
    ]);
    expect(queries[4].ops).toEqual(
      expect.arrayContaining([
        ['eq', 'audience', 'instructor'],
        ['eq', 'status', 'live'],
        ['eq', 'assign_to', 'all'],
      ]),
    );
    expect(queries[4].ops).not.toContainEqual(['eq', 'season', undefined]);
    expect(queries[6].ops.slice(0, 2)).toEqual([
      ['update', { required: false }],
      ['eq', 'id', ID],
    ]);
    expect(queries[7].ops).toContainEqual(['eq', 'season', '2026/27']);
    expect(queries[8].ops.slice(0, 3)).toEqual([
      ['update', { status: 'retired' }],
      ['eq', 'id', ID],
      ['in', 'status', ['live']],
    ]);
  });

  it('surfaces errors and a missing insert row', async () => {
    const { client } = recordingSupabase({
      document_templates: [fail, fail, ok(null), fail, fail, fail],
    });
    const repo = new SupabaseDocumentTemplatesRepository(client);
    await expect(repo.list()).rejects.toBeInstanceOf(DatabaseError);
    await expect(repo.findById(ID)).rejects.toThrow('load document template');
    await expect(
      repo.insert({ kind: 'sign', audience: 'instructor', title_en: 'A' }),
    ).rejects.toThrow('no row returned');
    await expect(repo.listLiveForAll('customer')).rejects.toThrow('boom');
    await expect(repo.update(ID, {})).rejects.toThrow('boom');
    await expect(repo.updateIfStatus(ID, ['live'], {})).rejects.toThrow('boom');
  });

  it('upserts and deletes language versions', async () => {
    const { client, queries } = recordingSupabase({
      document_template_translations: [
        ok(null),
        ok([{ template_id: ID }]),
        ok([]),
        fail,
        fail,
      ],
    });
    const repo = new SupabaseDocumentTemplatesRepository(client);
    await expect(
      repo.upsertTranslation(ID, 'en', { fields: [] }),
    ).resolves.toBeUndefined();
    await expect(repo.deleteTranslation(ID, 'en')).resolves.toBe(true);
    await expect(repo.deleteTranslation(ID, 'zh')).resolves.toBe(false);
    await expect(repo.upsertTranslation(ID, 'en', {})).rejects.toThrow(
      'save document template translation',
    );
    await expect(repo.deleteTranslation(ID, 'en')).rejects.toThrow('boom');
    expect(DOCUMENT_TEMPLATE_COLUMNS).toContain(
      'translations:document_template_translations(',
    );
    expect(queries[0].ops).toEqual([
      [
        'upsert',
        { fields: [], template_id: ID, language: 'en' },
        { onConflict: 'template_id,language' },
      ],
    ]);
    expect(queries[1].ops).toEqual([
      ['delete'],
      ['eq', 'template_id', ID],
      ['eq', 'language', 'en'],
      ['select', 'template_id'],
    ]);
  });
});

describe('SupabaseDocumentAssignmentsRepository', () => {
  it('lists per subject, finds and updates with the template embedded', async () => {
    const row = { id: ID };
    const { client, queries } = recordingSupabase({
      document_assignments: [ok([row]), ok(null), ok(row), ok(row), fail],
    });
    const repo = new SupabaseDocumentAssignmentsRepository(client);
    await expect(repo.listForSubject('instructor', ID)).resolves.toEqual([row]);
    await expect(repo.listForSubject('instructor', ID)).resolves.toEqual([]);
    await expect(repo.findById(ID)).resolves.toEqual(row);
    await expect(repo.update(ID, { status: 'archived' })).resolves.toEqual(row);
    await expect(repo.findById(ID)).rejects.toThrow('load document assignment');
    expect(DOCUMENT_ASSIGNMENT_COLUMNS).toContain(
      'template:document_templates(',
    );
    expect(queries[0].ops).toEqual([
      ['select', DOCUMENT_ASSIGNMENT_COLUMNS],
      ['eq', 'subject_type', 'instructor'],
      ['eq', 'subject_id', ID],
      ['order', 'assigned_at', { ascending: false }],
    ]);
  });

  it('finds open subjects in chunks, excluding archived rows', async () => {
    const ids = Array.from({ length: SUBJECT_ID_CHUNK + 1 }, (_, i) => `s${i}`);
    const { client, queries } = recordingSupabase({
      document_assignments: [ok([{ subject_id: 's1' }]), ok(null)],
    });
    const repo = new SupabaseDocumentAssignmentsRepository(client);
    const open = await repo.findOpenSubjectIds(
      ID,
      '2026-27',
      'instructor',
      ids,
    );
    expect([...open]).toEqual(['s1']);
    expect(queries).toHaveLength(2);
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['eq', 'template_id', ID],
        ['eq', 'season', '2026-27'],
        ['not', 'status', 'eq', 'archived'],
        ['in', 'subject_id', ids.slice(0, SUBJECT_ID_CHUNK)],
      ]),
    );
    expect(queries[1].ops).toContainEqual(['in', 'subject_id', ['s100']]);
    const failing = recordingSupabase({ document_assignments: [fail] });
    await expect(
      new SupabaseDocumentAssignmentsRepository(
        failing.client,
      ).findOpenSubjectIds(ID, 's', 'instructor', ['a']),
    ).rejects.toThrow('boom');
  });

  it('inserts many, and one if absent', async () => {
    const dup = {
      data: null,
      error: { message: 'dup', code: PG_UNIQUE_VIOLATION },
    };
    const { client, queries } = recordingSupabase({
      document_assignments: [ok(null), ok(null), dup, fail],
    });
    const repo = new SupabaseDocumentAssignmentsRepository(client);
    await expect(repo.insertMany([])).resolves.toBe(0);
    await expect(repo.insertMany([newRow, newRow])).resolves.toBe(2);
    await expect(repo.insertIfAbsent(newRow)).resolves.toBe(true);
    await expect(repo.insertIfAbsent(newRow)).resolves.toBe(false);
    await expect(repo.insertIfAbsent(newRow)).rejects.toThrow('boom');
    expect(queries[0].ops).toEqual([['insert', [newRow, newRow]]]);
  });

  it('tells whether a template has a completed assignment', async () => {
    const { client, queries } = recordingSupabase({
      document_assignments: [ok([{ id: ID }]), ok(null), fail],
    });
    const repo = new SupabaseDocumentAssignmentsRepository(client);
    await expect(repo.hasCompleted(ID)).resolves.toBe(true);
    await expect(repo.hasCompleted(ID)).resolves.toBe(false);
    await expect(repo.hasCompleted(ID)).rejects.toThrow('boom');
    expect(queries[0].ops).toEqual([
      ['select', 'id'],
      ['eq', 'template_id', ID],
      ['eq', 'status', 'completed'],
      ['limit', 1],
    ]);
  });
});

describe('SupabaseDocumentAssignmentsRepository.templateStats', () => {
  it('reads every template in one grouped rpc and skips the call for none', async () => {
    const { client, queries } = recordingSupabase({
      'rpc:document_template_stats': [
        ok([
          {
            template_id: ID,
            assigned_count: 3,
            completed_count: 1,
            has_completed: true,
            approved_assigned_count: 2,
            approved_completed_count: 1,
          },
        ]),
        ok(null),
        fail,
      ],
    });
    const repo = new SupabaseDocumentAssignmentsRepository(client);
    await expect(repo.templateStats([])).resolves.toEqual(new Map());
    expect(queries).toHaveLength(0);
    await expect(repo.templateStats([ID, 'other'])).resolves.toEqual(
      new Map([
        [
          ID,
          {
            assignedCount: 3,
            completedCount: 1,
            approvedAssignedCount: 2,
            approvedCompletedCount: 1,
            hasCompleted: true,
          },
        ],
      ]),
    );
    expect(queries[0]).toEqual({
      table: 'rpc:document_template_stats',
      ops: [['rpc', { p_template_ids: [ID, 'other'] }]],
    });
    await expect(repo.templateStats([ID])).resolves.toEqual(new Map());
    await expect(repo.templateStats([ID])).rejects.toThrow('boom');
  });
});

describe('SupabaseDocumentSubjectsRepository', () => {
  it('counts approved, active instructors', async () => {
    const { client, queries } = recordingSupabase({
      instructors: [
        { data: null, error: null, count: 4 },
        { data: null, error: null, count: null },
        fail,
      ],
    });
    const repo = new SupabaseDocumentSubjectsRepository(client);
    await expect(repo.countActiveApprovedInstructors()).resolves.toBe(4);
    await expect(repo.countActiveApprovedInstructors()).resolves.toBe(0);
    await expect(repo.countActiveApprovedInstructors()).rejects.toThrow('boom');
    expect(queries[0].ops).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
      ['eq', 'approval_status', 'approved'],
      ['eq', 'is_active', true],
    ]);
  });

  it('reads instructors, certifications and uploads', async () => {
    const instructor = { id: ID };
    const { client, queries } = recordingSupabase({
      instructors: [
        ok(instructor),
        ok(null),
        ok([{ id: 'a' }, { id: 'b' }]),
        ok([{ id: 'a' }]),
        { data: null, error: null, count: 3 },
        { data: null, error: null, count: null },
      ],
      instructor_certifications: [
        ok([{ org: 'csia', track: 'regular', level: 2 }]),
      ],
      certification_uploads: [ok(null)],
    });
    const repo = new SupabaseDocumentSubjectsRepository(client);
    await expect(repo.findInstructorByAuthUser('u')).resolves.toEqual(
      instructor,
    );
    await expect(repo.findInstructor(ID)).resolves.toBeNull();
    await expect(repo.listActiveApprovedInstructorIds()).resolves.toEqual([
      'a',
      'b',
    ]);
    await expect(repo.existingInstructorIds(['a', 'z'])).resolves.toEqual(
      new Set(['a']),
    );
    await expect(repo.listCertifications(ID)).resolves.toEqual([
      { org: 'csia', track: 'regular', level: 2 },
    ]);
    await expect(repo.listCertificationUploads(ID)).resolves.toEqual([]);
    await expect(repo.countPendingInstructors()).resolves.toBe(3);
    await expect(repo.countPendingInstructors()).resolves.toBe(0);
    expect(queries[6].ops).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
      ['eq', 'approval_status', 'pending'],
    ]);
    expect(queries[0].ops).toEqual([
      ['select', DOCUMENT_INSTRUCTOR_COLUMNS],
      ['eq', 'auth_user_id', 'u'],
      ['maybeSingle'],
    ]);
    expect(queries[2].ops).toEqual(
      expect.arrayContaining([
        ['eq', 'approval_status', 'approved'],
        ['eq', 'is_active', true],
      ]),
    );
    expect(queries[5].ops).toEqual([
      ['select', CERTIFICATION_UPLOAD_COLUMNS],
      ['eq', 'instructor_id', ID],
      ['order', 'inserted_at', { ascending: false }],
    ]);
  });

  it('surfaces errors', async () => {
    const { client } = recordingSupabase({
      instructors: [fail, fail, fail, fail, fail],
      instructor_certifications: [fail],
      certification_uploads: [fail],
    });
    const repo = new SupabaseDocumentSubjectsRepository(client);
    await expect(repo.findInstructorByAuthUser('u')).rejects.toThrow('boom');
    await expect(repo.findInstructor(ID)).rejects.toThrow('boom');
    await expect(repo.listActiveApprovedInstructorIds()).rejects.toThrow(
      'boom',
    );
    await expect(repo.existingInstructorIds(['a'])).rejects.toThrow('boom');
    await expect(repo.listCertifications(ID)).rejects.toThrow('boom');
    await expect(repo.listCertificationUploads(ID)).rejects.toThrow('boom');
    await expect(repo.countPendingInstructors()).rejects.toThrow('boom');
  });
});
