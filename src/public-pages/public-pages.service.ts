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
  type PublicPagePatch,
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
    const row = await this.save(id, { title: title.trim() }, actor);
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
    await this.storage.put(draftKey(page.slug), body);
    const row = await this.save(
      id,
      { draft_sha256: digest, draft_size_bytes: body.length },
      actor,
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
    const body = await this.storage.get(draftKey(page.slug));
    if (body === null) {
      throw new NotFoundException(PAGE_CONTENT_NOT_FOUND);
    }
    return body;
  }

  async publish(id: string, actor: AuditActor): Promise<PublicPage> {
    const page = await this.load(id);
    if (page.draft_sha256 === null) {
      throw new BadRequestException(PAGE_CONTENT_REQUIRED);
    }
    const body = await this.storage.get(draftKey(page.slug));
    if (body === null) {
      this.logger.error(`Draft object for page '${page.slug}' is missing`);
      throw new BadGatewayException(DOCS_STORAGE_UNAVAILABLE);
    }
    await this.storage.put(publishedKey(page.slug), body);
    const digest = sha256(body);
    const row = await this.save(
      id,
      {
        status: 'published',
        published_sha256: digest,
        published_at: new Date().toISOString(),
      },
      actor,
    );
    await this.record(AUDIT_ACTIONS.pagePublish, actor, row, {
      slug: row.slug,
      sha256: digest,
    });
    return this.toPublicPage(row);
  }

  async unpublish(id: string, actor: AuditActor): Promise<PublicPage> {
    const page = await this.load(id);
    await this.storage.delete(publishedKey(page.slug));
    const row = await this.save(
      id,
      { status: 'draft', published_sha256: null, published_at: null },
      actor,
    );
    await this.record(AUDIT_ACTIONS.pageUnpublish, actor, row, {
      slug: row.slug,
    });
    return this.toPublicPage(row);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const page = await this.load(id);
    await this.storage.delete(draftKey(page.slug));
    await this.storage.delete(publishedKey(page.slug));
    await this.repo.delete(id);
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

  private async save(
    id: string,
    patch: PublicPagePatch,
    actor: AuditActor,
  ): Promise<PublicPageRow> {
    const row = await this.repo.update(id, patch, actor.userId ?? null);
    if (!row) {
      throw new NotFoundException(PAGE_NOT_FOUND);
    }
    return row;
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
