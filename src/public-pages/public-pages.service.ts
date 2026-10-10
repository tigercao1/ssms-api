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

type StorageOperation = 'upload' | 'publish' | 'unpublish' | 'delete';

interface ObjectRestore {
  key: string;
  previous: Buffer | null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

@Injectable()
export class PublicPagesService {
  private readonly logger = new Logger(PublicPagesService.name);

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
  }

  async updateTitle(
    id: string,
    title: string,
    actor: AuditActor,
  ): Promise<PublicPage> {
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
    const page = await this.load(id);
    const digest = sha256(body);
    const key = draftKey(page.slug);
    const previous = await this.storage.get(key);
    await this.storage.put(key, body);
    const row = await this.commit(
      page,
      'upload',
      { key, previous },
      actor,
      () =>
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
  }

  async getContent(id: string): Promise<Buffer> {
    const page = await this.load(id);
    if (page.draft_sha256 === null) {
      throw new NotFoundException(PAGE_CONTENT_NOT_FOUND);
    }
    return this.readDraft(page);
  }

  async publish(id: string, actor: AuditActor): Promise<PublicPage> {
    const page = await this.load(id);
    if (page.draft_sha256 === null) {
      throw new BadRequestException(PAGE_CONTENT_REQUIRED);
    }
    const body = await this.readDraft(page);
    const key = publishedKey(page.slug);
    const previous = await this.storage.get(key);
    await this.storage.put(key, body);
    const digest = sha256(body);
    const row = await this.commit(
      page,
      'publish',
      { key, previous },
      actor,
      () =>
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
  }

  async unpublish(id: string, actor: AuditActor): Promise<PublicPage> {
    const page = await this.load(id);
    const key = publishedKey(page.slug);
    const previous = await this.storage.get(key);
    await this.storage.delete(key);
    const row = await this.commit(
      page,
      'unpublish',
      { key, previous },
      actor,
      () =>
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
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const page = await this.load(id);
    const key = publishedKey(page.slug);
    const previous = await this.storage.get(key);
    await this.storage.delete(key);
    await this.commit(page, 'delete', { key, previous }, actor, async () =>
      (await this.repo.delete(id, page.updated_at)) ? true : null,
    );
    try {
      await this.storage.delete(draftKey(page.slug));
    } catch (err) {
      this.logger.warn(
        `Orphaned draft ${draftKey(page.slug)} left after deleting page ${page.id}: ${describeError(err)}`,
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

  private async readDraft(page: PublicPageRow): Promise<Buffer> {
    const body = await this.storage.get(draftKey(page.slug));
    if (body === null) {
      this.logger.error(
        `Draft object ${draftKey(page.slug)} for page ${page.id} is missing`,
      );
      throw new BadGatewayException(DOCS_STORAGE_UNAVAILABLE);
    }
    return body;
  }

  private async commit<T>(
    page: PublicPageRow,
    operation: StorageOperation,
    restore: ObjectRestore,
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
      failure = err instanceof Error ? err : new Error(String(err));
    }
    await this.compensate(page, operation, restore, actor, failure);
    throw failure;
  }

  private async compensate(
    page: PublicPageRow,
    operation: StorageOperation,
    { key, previous }: ObjectRestore,
    actor: AuditActor,
    failure: Error,
  ): Promise<void> {
    try {
      if (previous === null) {
        await this.storage.delete(key);
      } else {
        await this.storage.put(key, previous);
      }
      return;
    } catch (err) {
      const reason = failure.message;
      this.logger.error(
        `Storage inconsistent: ${operation} of page ${page.id} (${page.slug}) failed (${reason}) and restoring ${key} failed (${describeError(err)})`,
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
    throw new BadGatewayException(DOCS_STORAGE_UNAVAILABLE);
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
