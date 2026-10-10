import { randomUUID } from 'node:crypto';
import { BadGatewayException } from '@nestjs/common';
import type { AuditEntry } from '../../src/audit/audit.types';
import {
  DOCS_STORAGE_UNAVAILABLE,
  DocsStorageClient,
} from '../../src/public-pages/docs-storage.client';
import {
  type CreatePublicPageInput,
  DuplicateSlugError,
  type PublicPagePatch,
  PublicPagesRepository,
} from '../../src/public-pages/public-pages.repository';
import type { PublicPageRow } from '../../src/public-pages/public-pages.types';

export const DOCS_BASE_URL = 'https://docs.example.test';

export class InMemoryPublicPagesRepository extends PublicPagesRepository {
  readonly rows = new Map<string, PublicPageRow>();
  private clock = Date.parse('2026-10-01T00:00:00.000Z');

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  list(): Promise<PublicPageRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((row) => ({ ...row })),
    );
  }

  findById(id: string): Promise<PublicPageRow | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? { ...row } : null);
  }

  create(input: CreatePublicPageInput): Promise<PublicPageRow> {
    if ([...this.rows.values()].some((row) => row.slug === input.slug)) {
      return Promise.reject(new DuplicateSlugError(input.slug));
    }
    const now = this.tick();
    const row: PublicPageRow = {
      id: randomUUID(),
      slug: input.slug,
      title: input.title,
      status: 'draft',
      draft_sha256: null,
      draft_size_bytes: null,
      published_sha256: null,
      published_at: null,
      created_by: input.userId,
      updated_by: input.userId,
      created_at: now,
      updated_at: now,
    };
    this.rows.set(row.id, row);
    return Promise.resolve({ ...row });
  }

  update(
    id: string,
    patch: PublicPagePatch,
    userId: string | null,
  ): Promise<PublicPageRow | null> {
    const row = this.rows.get(id);
    if (!row) {
      return Promise.resolve(null);
    }
    const next = {
      ...row,
      ...patch,
      updated_by: userId,
      updated_at: this.tick(),
    };
    this.rows.set(id, next);
    return Promise.resolve({ ...next });
  }

  delete(id: string): Promise<void> {
    this.rows.delete(id);
    return Promise.resolve();
  }

  snapshot(): PublicPageRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
}

export class FakeDocsStorage extends DocsStorageClient {
  readonly objects = new Map<string, Buffer>();
  readonly calls: string[] = [];
  configured = true;
  failing = false;

  isConfigured(): boolean {
    return this.configured;
  }

  publicUrl(slug: string): string {
    return `${DOCS_BASE_URL}/${slug}`;
  }

  put(key: string, body: Buffer): Promise<void> {
    this.calls.push(`PUT ${key}`);
    this.fail();
    this.objects.set(key, Buffer.from(body));
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer | null> {
    this.calls.push(`GET ${key}`);
    this.fail();
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  delete(key: string): Promise<void> {
    this.calls.push(`DELETE ${key}`);
    this.fail();
    this.objects.delete(key);
    return Promise.resolve();
  }

  private fail(): void {
    if (this.failing) {
      throw new BadGatewayException(DOCS_STORAGE_UNAVAILABLE);
    }
  }
}

export function recordingAudit() {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record: (entry: AuditEntry) => {
      entries.push(entry);
      return Promise.resolve();
    },
  };
}
