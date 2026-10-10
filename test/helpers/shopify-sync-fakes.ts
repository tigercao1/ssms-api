import { InstructorSyncRepository } from '../../src/shopify-sync/instructor-sync.repository';
import type {
  InstructorShopifyState,
  InstructorShopifyStatePatch,
  InstructorSnapshot,
  ReconcileCounts,
  SyncInstructorRow,
  SyncQueueRow,
} from '../../src/shopify-sync/instructor-sync.types';
import {
  type ShopifySyncHeartbeat,
  type ShopifySyncSettingsRow,
  ShopifySyncSettingsRepository,
  type ShopifySyncStats,
} from '../../src/shopify-sync/shopify-sync-settings.repository';
import type { ShopifyAdminClient } from '../../src/shopify/shopify-admin.client';
import type { ShopifyUserError } from '../../src/shopify/shopify.errors';

export const INSTRUCTOR_ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';

export function instructorRow(
  overrides: Partial<SyncInstructorRow> = {},
): SyncInstructorRow {
  return {
    id: INSTRUCTOR_ID,
    display_name_en: 'Eddie Chen',
    display_name_zh: '陈艾迪',
    bio_en: 'Loves powder.',
    bio_zh: '热爱粉雪。',
    profile_photo_url: null,
    profile_photo_version: null,
    photo_2_url: null,
    photo_2_version: null,
    photo_3_url: null,
    photo_3_version: null,
    min_student_age: 6,
    approval_status: 'approved',
    is_active: true,
    ...overrides,
  };
}

export function snapshotOf(
  overrides: Partial<Omit<InstructorSnapshot, 'instructor'>> & {
    instructor?: Partial<SyncInstructorRow>;
  } = {},
): InstructorSnapshot {
  const { instructor, ...rest } = overrides;
  return {
    instructor: instructorRow(instructor),
    locations: [],
    languages: [],
    courseLevels: [],
    examPreparations: [],
    certifications: [],
    trainers: [],
    ...rest,
  };
}

export class InMemorySyncRepository extends InstructorSyncRepository {
  snapshots = new Map<string, InstructorSnapshot>();
  states = new Map<string, InstructorShopifyState>();
  queue = new Map<string, SyncQueueRow>();
  claimCalls: { limit: number; maxAttempts: number }[] = [];
  counts: ReconcileCounts = { instructors: 0, orphaned: 0 };
  onSync?: (instructorId: string) => void;

  loadSnapshot(instructorId: string): Promise<InstructorSnapshot | null> {
    this.onSync?.(instructorId);
    return Promise.resolve(this.snapshots.get(instructorId) ?? null);
  }

  getState(instructorId: string): Promise<InstructorShopifyState | null> {
    const state = this.states.get(instructorId);
    return Promise.resolve(state ? { ...state } : null);
  }

  saveState(
    instructorId: string,
    patch: InstructorShopifyStatePatch,
  ): Promise<void> {
    const current = this.states.get(instructorId) ?? {
      instructor_id: instructorId,
      shopify_metaobject_id: null,
      shopify_handle: null,
      shopify_photo_file_id: null,
      synced_photo_version: null,
      shopify_photo_2_file_id: null,
      synced_photo_2_version: null,
      shopify_photo_3_file_id: null,
      synced_photo_3_version: null,
      last_synced_at: null,
      last_status: null,
    };
    this.states.set(instructorId, { ...current, ...patch });
    return Promise.resolve();
  }

  isHandleStoredByOther(
    handle: string,
    instructorId: string,
  ): Promise<boolean> {
    return Promise.resolve(
      [...this.states.values()].some(
        (s) => s.shopify_handle === handle && s.instructor_id !== instructorId,
      ),
    );
  }

  claimQueueBatch(limit: number, maxAttempts: number): Promise<SyncQueueRow[]> {
    this.claimCalls.push({ limit, maxAttempts });
    return Promise.resolve(
      [...this.queue.values()]
        .sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at))
        .slice(0, limit)
        .map((row) => ({ ...row })),
    );
  }

  completeQueueRow(row: SyncQueueRow): Promise<void> {
    if (this.queue.get(row.instructor_id)?.enqueued_at === row.enqueued_at) {
      this.queue.delete(row.instructor_id);
    }
    return Promise.resolve();
  }

  recordQueueFailure(row: SyncQueueRow, message: string): Promise<void> {
    const current = this.queue.get(row.instructor_id);
    if (current) {
      this.queue.set(row.instructor_id, {
        ...current,
        attempts: row.attempts + 1,
        last_error: message,
      });
    }
    return Promise.resolve();
  }

  enqueueAll(): Promise<ReconcileCounts> {
    return Promise.resolve(this.counts);
  }

  signedUrls: { bucket: string; path: string; expiresInSeconds: number }[] = [];

  createSignedPhotoUrl(
    bucket: string,
    path: string,
    expiresInSeconds: number,
  ): Promise<string> {
    this.signedUrls.push({ bucket, path, expiresInSeconds });
    return Promise.resolve(
      `https://storage.test/${bucket}/${path}?token=signed-${this.signedUrls.length}`,
    );
  }
}

export class InMemorySettingsRepository extends ShopifySyncSettingsRepository {
  settings: ShopifySyncSettingsRow | null = {
    enabled: false,
    updated_at: '2026-10-10T00:00:00.000Z',
    updated_by: null,
    last_tick_at: null,
    last_success_at: null,
    last_error: null,
    last_error_at: null,
  };
  settingsReads = 0;
  heartbeats: ShopifySyncHeartbeat[] = [];
  instructors = new Set<string>();
  statsCalls: number[] = [];

  constructor(private readonly sync: InMemorySyncRepository) {
    super();
  }

  getSettings(): Promise<ShopifySyncSettingsRow | null> {
    this.settingsReads++;
    return Promise.resolve(this.settings ? { ...this.settings } : null);
  }

  setEnabled(
    enabled: boolean,
    userId: string | null,
  ): Promise<ShopifySyncSettingsRow> {
    if (!this.settings) {
      return Promise.reject(new Error('Shopify sync settings row is missing'));
    }
    this.settings = {
      ...this.settings,
      enabled,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    return Promise.resolve({ ...this.settings });
  }

  recordHeartbeat(heartbeat: ShopifySyncHeartbeat): Promise<void> {
    this.heartbeats.push(heartbeat);
    if (this.settings) {
      this.settings = { ...this.settings, ...heartbeat };
    }
    return Promise.resolve();
  }

  stats(maxAttempts: number): Promise<ShopifySyncStats> {
    this.statsCalls.push(maxAttempts);
    const queue = [...this.sync.queue.values()];
    const entries = [...this.sync.states.values()].filter(
      (s) => s.shopify_metaobject_id,
    );
    const oldest = queue.map((r) => r.enqueued_at).sort()[0] ?? null;
    return Promise.resolve({
      pending: queue.filter((r) => r.attempts === 0).length,
      retrying: queue.filter((r) => r.attempts > 0 && r.attempts < maxAttempts)
        .length,
      failed: queue.filter((r) => r.attempts >= maxAttempts).length,
      oldestEnqueuedAt: oldest,
      synced: entries.length,
      active: entries.filter((s) => s.last_status === 'active').length,
      draft: entries.filter((s) => s.last_status === 'draft').length,
    });
  }

  queueRow(instructorId: string): Promise<SyncQueueRow | null> {
    const row = this.sync.queue.get(instructorId);
    return Promise.resolve(row ? { ...row } : null);
  }

  instructorExists(instructorId: string): Promise<boolean> {
    return Promise.resolve(this.instructors.has(instructorId));
  }

  enqueueInstructor(instructorId: string): Promise<void> {
    const current = this.sync.queue.get(instructorId);
    this.sync.queue.set(instructorId, {
      instructor_id: instructorId,
      enqueued_at: new Date().toISOString(),
      attempts: 0,
      last_error: current?.last_error ?? null,
    });
    return Promise.resolve();
  }
}

export interface FakeFile {
  id: string;
  filename: string;
  originalSource: string;
  statuses: string[];
  errors: { code: string; message: string }[];
}

export interface FakeEntry {
  id: string;
  handle: string;
  type: string;
  fields: Record<string, string>;
  status: string | undefined;
}

interface RegisteredTranslation {
  value: string;
  digest: string;
}

export interface GraphqlCall {
  operation: string;
  variables: Record<string, unknown>;
}

export interface FakeVariables {
  handle: { type: string; handle: string };
  files: {
    originalSource: string;
    filename: string;
    contentType: string;
    duplicateResolutionMode: string;
  }[];
  fileIds: string[];
  id: string;
  query: string;
  resourceId: string;
  locale: string;
  locales: string[];
  translationKeys: string[];
  translations: {
    key: string;
    value: string;
    locale: string;
    translatableContentDigest: string;
  }[];
  metaobject: {
    fields?: { key: string; value: string }[];
    capabilities?: { publishable?: { status?: string } };
  };
  [key: string]: unknown;
}

type Handler = (variables: FakeVariables) => unknown;

export class FakeShopify {
  entries = new Map<string, FakeEntry>();
  files = new Map<string, FakeFile>();
  translations = new Map<string, Map<string, RegisteredTranslation>>();
  fileStatuses = ['UPLOADED', 'PROCESSING', 'READY'];
  calls: GraphqlCall[] = [];
  userErrors = new Map<string, ShopifyUserError[]>();
  private nextId = 1;
  private readonly handlers: Record<string, Handler> = {
    SsmsInstructorByHandle: (v) => {
      const entry = this.entryAt(v.handle.type, v.handle.handle);
      return {
        metaobjectByHandle: entry
          ? {
              id: entry.id,
              ssmsId:
                entry.fields.ssms_id === undefined
                  ? null
                  : { value: entry.fields.ssms_id },
            }
          : null,
      };
    },
    SsmsInstructorUpsert: (v) => {
      const errors = this.takeErrors('SsmsInstructorUpsert');
      if (errors) {
        return { metaobjectUpsert: { metaobject: null, userErrors: errors } };
      }
      const key = `${v.handle.type}/${v.handle.handle}`;
      const entry = this.entries.get(key) ?? {
        id: `gid://shopify/Metaobject/${this.nextId++}`,
        handle: v.handle.handle,
        type: v.handle.type,
        fields: {},
        status: undefined,
      };
      for (const field of v.metaobject.fields ?? []) {
        entry.fields[field.key] = field.value;
      }
      entry.status = v.metaobject.capabilities?.publishable?.status;
      this.entries.set(key, entry);
      return {
        metaobjectUpsert: {
          metaobject: { id: entry.id, handle: entry.handle },
          userErrors: [],
        },
      };
    },
  };

  private readonly fileHandlers: Record<string, Handler> = {
    SsmsPhotoCreate: (v) => {
      const [input] = v.files;
      if (this.fileNamed(input.filename)) {
        return {
          fileCreate: {
            files: [],
            userErrors: [
              {
                field: ['files', '0', 'filename'],
                message: 'The provided filename already exists.',
                code: 'FILENAME_ALREADY_EXISTS',
              },
            ],
          },
        };
      }
      const file = this.addFile(input.filename, [...this.fileStatuses]);
      file.originalSource = input.originalSource;
      return {
        fileCreate: {
          files: [{ id: file.id, fileStatus: file.statuses[0] }],
          userErrors: [],
        },
      };
    },
    SsmsPhotoByName: (v) => {
      const name = /filename:"(.+)"/.exec(v.query)?.[1] ?? '';
      const file = this.fileNamed(name);
      return {
        files: {
          nodes: file
            ? [
                {
                  id: file.id,
                  fileStatus: file.statuses[0],
                  image: { url: `https://cdn.test/files/${file.filename}?v=1` },
                },
              ]
            : [],
        },
      };
    },
    SsmsPhotoStatus: (v) => {
      const file = this.files.get(v.id);
      if (!file) {
        return { node: null };
      }
      if (file.statuses.length > 1) {
        file.statuses.shift();
      }
      return {
        node: {
          id: file.id,
          fileStatus: file.statuses[0],
          fileErrors: file.errors,
        },
      };
    },
    SsmsPhotoDelete: (v) => {
      const errors = this.takeErrors('SsmsPhotoDelete');
      if (errors) {
        return { fileDelete: { deletedFileIds: null, userErrors: errors } };
      }
      for (const id of v.fileIds) {
        this.files.delete(id);
      }
      return { fileDelete: { deletedFileIds: v.fileIds, userErrors: [] } };
    },
  };

  private readonly translationHandlers: Record<string, Handler> = {
    SsmsInstructorTranslations: (v) => {
      const entry = this.entryById(v.resourceId);
      if (!entry) {
        return { translatableResource: null };
      }
      const registered =
        this.translations.get(entry.id) ??
        new Map<string, RegisteredTranslation>();
      return {
        translatableResource: {
          translatableContent: Object.entries(entry.fields)
            .filter(([, value]) => value !== '')
            .map(([key, value]) => ({ key, digest: digestOf(value) })),
          translations: [...registered.entries()].map(([key, t]) => ({
            key,
            value: t.value,
            outdated: t.digest !== digestOf(entry.fields[key] ?? ''),
          })),
        },
      };
    },
    SsmsTranslationsRegister: (v) => {
      const errors = this.takeErrors('SsmsTranslationsRegister');
      if (errors) {
        return { translationsRegister: { userErrors: errors } };
      }
      const registered =
        this.translations.get(v.resourceId) ??
        new Map<string, RegisteredTranslation>();
      for (const t of v.translations) {
        registered.set(t.key, {
          value: t.value,
          digest: t.translatableContentDigest,
        });
      }
      this.translations.set(v.resourceId, registered);
      return { translationsRegister: { userErrors: [] } };
    },
    SsmsTranslationsRemove: (v) => {
      const registered = this.translations.get(v.resourceId);
      for (const key of v.translationKeys) {
        registered?.delete(key);
      }
      return { translationsRemove: { userErrors: [] } };
    },
  };

  translationsFor(handle: string): Record<string, string> {
    const entry = this.entry(handle);
    const registered = entry ? this.translations.get(entry.id) : undefined;
    return Object.fromEntries(
      [...(registered?.entries() ?? [])].map(([key, t]) => [key, t.value]),
    );
  }

  private entryById(id: string): FakeEntry | undefined {
    return [...this.entries.values()].find((e) => e.id === id);
  }

  addFile(filename: string, statuses: string[] = ['READY']): FakeFile {
    const file: FakeFile = {
      id: `gid://shopify/MediaImage/${this.nextId++}`,
      filename,
      originalSource: '',
      statuses,
      errors: [],
    };
    this.files.set(file.id, file);
    return file;
  }

  fileNamed(filename: string): FakeFile | undefined {
    return [...this.files.values()].find((f) => f.filename === filename);
  }

  readonly client = {
    graphql: jest.fn((query: string, variables: Record<string, unknown> = {}) =>
      Promise.resolve().then(() => this.dispatch(query, variables)),
    ),
  } as unknown as ShopifyAdminClient & { graphql: jest.Mock };

  on(operation: string, handler: Handler): void {
    this.handlers[operation] = handler;
  }

  failNext(operation: string, errors: ShopifyUserError[]): void {
    this.userErrors.set(operation, errors);
  }

  addEntry(handle: string, fields: Record<string, string> = {}): FakeEntry {
    const entry: FakeEntry = {
      id: `gid://shopify/Metaobject/${this.nextId++}`,
      handle,
      type: 'ssms_instructor',
      fields,
      status: 'ACTIVE',
    };
    this.entries.set(`ssms_instructor/${handle}`, entry);
    return entry;
  }

  entry(handle: string): FakeEntry | undefined {
    return this.entryAt('ssms_instructor', handle);
  }

  operations(): string[] {
    return this.calls.map((c) => c.operation);
  }

  private entryAt(type: string, handle: string): FakeEntry | undefined {
    return this.entries.get(`${type}/${handle}`);
  }

  private takeErrors(operation: string): ShopifyUserError[] | undefined {
    const errors = this.userErrors.get(operation);
    this.userErrors.delete(operation);
    return errors;
  }

  private dispatch(query: string, variables: Record<string, unknown>): unknown {
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '';
    this.calls.push({ operation, variables });
    const handler =
      this.handlers[operation] ??
      this.fileHandlers[operation] ??
      this.translationHandlers[operation];
    if (!handler) {
      throw new Error(`Unexpected Shopify operation ${operation}`);
    }
    return handler(variables as FakeVariables);
  }
}

function digestOf(value: string): string {
  return `digest:${value}`;
}
