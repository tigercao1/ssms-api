import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditActor,
} from '../audit/audit.types';
import {
  DOCS_STORAGE_UNAVAILABLE,
  DocsStorageClient,
} from './docs-storage.client';
import { KeyedLock } from './keyed-lock';
import {
  DuplicateSlugError,
  PublicPagesRepository,
} from './public-pages.repository';
import {
  draftKey,
  PAGE_CONTENT_MAX_BYTES,
  publishedKey,
  type PublicPage,
  type PublicPageRow,
} from './public-pages.types';

export const PAGE_NOT_FOUND = 'Page not found';
export const PAGE_CONTENT_NOT_FOUND = 'Page has no content';
export const PAGE_CONTENT_REQUIRED = 'Upload content before publishing';
export const PAGE_CONTENT_EMPTY = 'Page content must not be empty';
export const PAGE_CONTENT_TOO_LARGE = `Page content must be at most ${PAGE_CONTENT_MAX_BYTES} bytes`;

export const PAGE_CONFLICT =
  'This page was changed by someone else. Reload and try again.';

type StorageOperation = 'read' | 'upload' | 'publish' | 'unpublish' | 'delete';

interface ObjectSnapshot {
  key: string;
  previous: Buffer | null;
  body: Buffer | null;
}

interface ObjectTarget {
  key: string;
  sha256: string | null;
}

const pageLock = (id: string): string => `page:${id}`;
const slugLock = (slug: string): string => `slug:${slug}`;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

@Injectable()
export class PublicPagesService {
  private readonly logger = new Logger(PublicPagesService.name);
  private readonly locks = new KeyedLock();

  constructor(
    private readonly repo: PublicPagesRepository,
    private readonly storage: DocsStorageClient,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<PublicPage[]> {
    const rows = await this.repo.list();
    return rows.map((row) => this.toPublicPage(row));
  }

  async create(
    slug: string,
    title: string,
    actor: AuditActor,
  ): Promise<PublicPage> {
    return this.locks.run(slugLock(slug), async () => {
      let row: PublicPageRow;
      try {
        row = await this.repo.create({
          slug,
          title: title.trim(),
          userId: actor.userId ?? null,
        });
      } catch (err) {
        if (err instanceof DuplicateSlugError) {
          throw new ConflictException(`Slug '${slug}' is already taken`);
        }
        throw err;
      }
      await this.record(AUDIT_ACTIONS.pageCreate, actor, row, {
        slug: row.slug,
        title: row.title,
      });
      return this.toPublicPage(row);
    });
  }

  updateTitle(
    id: string,
    title: string,
    actor: AuditActor,
  ): Promise<PublicPage> {
    return this.locks.run(pageLock(id), async () => {
      const before = await this.load(id);
      const row = await this.repo.update(
        id,
        before.updated_at,
        { title: title.trim() },
        actor.userId ?? null,
      );
      if (!row) {
        throw new ConflictException(PAGE_CONFLICT);
      }
      await this.record(AUDIT_ACTIONS.pageUpdate, actor, row, {
        slug: row.slug,
        before: { title: before.title },
        after: { title: row.title },
      });
      return this.toPublicPage(row);
    });
  }

  async uploadContent(
    id: string,
    body: Buffer,
    actor: AuditActor,
  ): Promise<PublicPage> {
    if (body.length === 0) {
      throw new BadRequestException(PAGE_CONTENT_EMPTY);
    }
    if (body.length > PAGE_CONTENT_MAX_BYTES) {
      throw new PayloadTooLargeException(PAGE_CONTENT_TOO_LARGE);
    }
    return this.locks.run(pageLock(id), async () => {
      const page = await this.load(id);
      const digest = sha256(body);
      const key = draftKey(page.slug);
      const snapshot = { key, previous: await this.storage.get(key), body };
      await this.mutate(page, 'upload', snapshot, actor, () =>
        this.storage.put(key, body),
      );
      const row = await this.commit(page, 'upload', snapshot, actor, () =>
        this.repo.update(
          id,
          page.updated_at,
          { draft_sha256: digest, draft_size_bytes: body.length },
          actor.userId ?? null,
        ),
      );
      await this.record(AUDIT_ACTIONS.pageUpload, actor, row, {
        slug: row.slug,
        sizeBytes: body.length,
        sha256: digest,
      });
      return this.toPublicPage(row);
    });
  }

  async getContent(id: string, actor: AuditActor): Promise<Buffer> {
    const page = await this.load(id);
    if (page.draft_sha256 === null) {
      throw new NotFoundException(PAGE_CONTENT_NOT_FOUND);
    }
    return this.readDraft(page, 'read', actor);
  }

  publish(id: string, actor: AuditActor): Promise<PublicPage> {
    return this.locks.run(pageLock(id), async () => {
      const page = await this.load(id);
      if (page.draft_sha256 === null) {
        throw new BadRequestException(PAGE_CONTENT_REQUIRED);
      }
      const body = await this.readDraft(page, 'publish', actor);
      const key = publishedKey(page.slug);
      const snapshot = { key, previous: await this.storage.get(key), body };
      await this.mutate(page, 'publish', snapshot, actor, () =>
        this.storage.put(key, body),
      );
      const digest = sha256(body);
      const row = await this.commit(page, 'publish', snapshot, actor, () =>
        this.repo.update(
          id,
          page.updated_at,
          {
            status: 'published',
            published_sha256: digest,
            published_at: new Date().toISOString(),
          },
          actor.userId ?? null,
        ),
      );
      await this.record(AUDIT_ACTIONS.pagePublish, actor, row, {
        slug: row.slug,
        sha256: digest,
      });
      return this.toPublicPage(row);
    });
  }

  unpublish(id: string, actor: AuditActor): Promise<PublicPage> {
    return this.locks.run(pageLock(id), async () => {
      const page = await this.load(id);
      const key = publishedKey(page.slug);
      const snapshot = {
        key,
        previous: await this.storage.get(key),
        body: null,
      };
      await this.mutate(page, 'unpublish', snapshot, actor, () =>
        this.storage.delete(key),
      );
      const row = await this.commit(page, 'unpublish', snapshot, actor, () =>
        this.repo.update(
          id,
          page.updated_at,
          { status: 'draft', published_sha256: null, published_at: null },
          actor.userId ?? null,
        ),
      );
      await this.record(AUDIT_ACTIONS.pageUnpublish, actor, row, {
        slug: row.slug,
      });
      return this.toPublicPage(row);
    });
  }

  remove(id: string, actor: AuditActor): Promise<void> {
    return this.locks.run(pageLock(id), async () => {
      const page = await this.load(id);
      await this.locks.run(slugLock(page.slug), () =>
        this.removeLoaded(page, actor),
      );
    });
  }

  private async removeLoaded(
    page: PublicPageRow,
    actor: AuditActor,
  ): Promise<void> {
    const key = publishedKey(page.slug);
    const snapshot = { key, previous: await this.storage.get(key), body: null };
    await this.mutate(page, 'delete', snapshot, actor, () =>
      this.storage.delete(key),
    );
    await this.commit(page, 'delete', snapshot, actor, async () =>
      (await this.repo.delete(page.id, page.updated_at)) ? true : null,
    );
    const draft = draftKey(page.slug);
    try {
      await this.storage.delete(draft);
    } catch (err) {
      await this.reportInconsistent(
        page,
        'delete',
        draft,
        actor,
        toError(err),
        `${draft} was left after the row was deleted`,
      );
    }
    await this.record(AUDIT_ACTIONS.pageDelete, actor, page, {
      slug: page.slug,
      title: page.title,
    });
  }

  private async load(id: string): Promise<PublicPageRow> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(PAGE_NOT_FOUND);
    }
    return row;
  }

  private async readDraft(
    page: PublicPageRow,
    operation: StorageOperation,
    actor: AuditActor,
  ): Promise<Buffer> {
    const key = draftKey(page.slug);
    const body = await this.storage.get(key);
    if (body === null) {
      await this.reportInconsistent(
        page,
        operation,
        key,
        actor,
        new Error(`${key} is missing`),
        `the database records draft sha256 ${page.draft_sha256}`,
      );
      throw new BadGatewayException(DOCS_STORAGE_UNAVAILABLE);
    }
    return body;
  }

  private async mutate(
    page: PublicPageRow,
    operation: StorageOperation,
    snapshot: ObjectSnapshot,
    actor: AuditActor,
    apply: () => Promise<void>,
  ): Promise<void> {
    try {
      await apply();
    } catch (err) {
      const failure = toError(err);
      await this.reconcile(page, operation, snapshot, actor, failure);
      throw failure;
    }
  }

  private async commit<T>(
    page: PublicPageRow,
    operation: StorageOperation,
    snapshot: ObjectSnapshot,
    actor: AuditActor,
    write: () => Promise<T | null>,
  ): Promise<T> {
    let failure: Error;
    try {
      const result = await write();
      if (result !== null) {
        return result;
      }
      failure = new ConflictException(PAGE_CONFLICT);
    } catch (err) {
      failure = toError(err);
    }
    await this.reconcile(page, operation, snapshot, actor, failure);
    throw failure;
  }

  private async reconcile(
    page: PublicPageRow,
    operation: StorageOperation,
    snapshot: ObjectSnapshot,
    actor: AuditActor,
    failure: Error,
  ): Promise<void> {
    let row: PublicPageRow | null;
    try {
      row = await this.repo.findById(page.id);
    } catch (err) {
      await this.restoreSnapshot(page.slug, snapshot);
      await this.reportInconsistent(
        page,
        operation,
        snapshot.key,
        actor,
        failure,
        `re-reading the page failed (${describeError(err)})`,
      );
      throw new BadGatewayException(DOCS_STORAGE_UNAVAILABLE);
    }
    for (const target of this.reconcileTargets(page, snapshot, row)) {
      let problem: string | null;
      try {
        problem = await this.converge(page.slug, target, snapshot);
      } catch (err) {
        problem = `restoring ${target.key} failed (${describeError(err)})`;
      }
      if (problem !== null) {
        await this.reportInconsistent(
          page,
          operation,
          target.key,
          actor,
          failure,
          problem,
        );
        throw new BadGatewayException(DOCS_STORAGE_UNAVAILABLE);
      }
    }
  }

  private async restoreSnapshot(
    slug: string,
    snapshot: ObjectSnapshot,
  ): Promise<void> {
    const target: ObjectTarget = {
      key: snapshot.key,
      sha256: snapshot.previous === null ? null : sha256(snapshot.previous),
    };
    try {
      await this.converge(slug, target, snapshot);
    } catch (err) {
      this.logger.warn(
        `Restoring ${snapshot.key} from its snapshot failed: ${describeError(err)}`,
      );
    }
  }

  private reconcileTargets(
    page: PublicPageRow,
    snapshot: ObjectSnapshot,
    row: PublicPageRow | null,
  ): ObjectTarget[] {
    const published: ObjectTarget = {
      key: publishedKey(page.slug),
      sha256: row?.status === 'published' ? row.published_sha256 : null,
    };
    const draft: ObjectTarget = {
      key: draftKey(page.slug),
      sha256: row?.draft_sha256 ?? null,
    };
    return snapshot.key === draft.key ? [draft, published] : [published, draft];
  }

  private async converge(
    slug: string,
    target: ObjectTarget,
    snapshot: ObjectSnapshot,
  ): Promise<string | null> {
    const existing = await this.storage.get(target.key);
    if (target.sha256 === null) {
      if (existing !== null) {
        await this.storage.delete(target.key);
      }
      return null;
    }
    const candidates: (() => Promise<Buffer | null>)[] = [
      () => Promise.resolve(existing),
      () =>
        Promise.resolve(snapshot.key === target.key ? snapshot.previous : null),
      () => Promise.resolve(snapshot.body),
    ];
    if (target.key === publishedKey(slug)) {
      candidates.push(() => this.storage.get(draftKey(slug)));
    }
    for (const candidate of candidates) {
      const body = await candidate();
      if (body !== null && sha256(body) === target.sha256) {
        if (body !== existing) {
          await this.storage.put(target.key, body);
        }
        return null;
      }
    }
    return `no stored body matches sha256 ${target.sha256} for ${target.key}`;
  }

  private async reportInconsistent(
    page: PublicPageRow,
    operation: StorageOperation,
    key: string,
    actor: AuditActor,
    failure: Error,
    problem: string,
  ): Promise<void> {
    const reason = failure.message;
    this.logger.error(
      `Storage inconsistent: ${operation} of page ${page.id} (${page.slug}) failed (${reason}) and ${problem}`,
    );
    try {
      await this.audit.record({
        action: AUDIT_ACTIONS.pageStorageInconsistent,
        actor,
        targetType: 'public_page',
        targetId: page.id,
        metadata: { slug: page.slug, operation, object: key, reason },
      });
    } catch (auditErr) {
      this.logger.error(
        `Failed to audit storage inconsistency for page ${page.id}: ${describeError(auditErr)}`,
      );
    }
  }

  private record(
    action: AuditAction,
    actor: AuditActor,
    row: PublicPageRow,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      action,
      actor,
      targetType: 'public_page',
      targetId: row.id,
      metadata,
    });
  }

  private toPublicPage(row: PublicPageRow): PublicPage {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      status: row.status,
      hasContent: row.draft_sha256 !== null,
      sizeBytes: row.draft_size_bytes,
      hasUnpublishedChanges:
        row.status === 'published' && row.draft_sha256 !== row.published_sha256,
      url: this.storage.publicUrl(row.slug),
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
