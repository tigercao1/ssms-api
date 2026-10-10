import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  DOCS_BASE_URL,
  FakeDocsStorage,
  InMemoryPublicPagesRepository,
  recordingAudit,
} from '../../test/helpers/public-pages-fakes';
import type { AuditService } from '../audit/audit.service';
import type { AuditActor } from '../audit/audit.types';
import { PublicPagesService } from './public-pages.service';
import { PAGE_CONTENT_MAX_BYTES } from './public-pages.types';

const ADMIN_ID = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const actor: AuditActor = { userId: ADMIN_ID, role: 'admin', userAgent: 'ua' };

const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

function build() {
  const repo = new InMemoryPublicPagesRepository();
  const storage = new FakeDocsStorage();
  const audit = recordingAudit();
  const service = new PublicPagesService(
    repo,
    storage,
    audit as unknown as AuditService,
  );
  return { repo, storage, audit, service };
}

describe('PublicPagesService', () => {
  const html = Buffer.from('<!doctype html><h1>Rates</h1>');

  it('creates a draft page and audits it', async () => {
    const { service, audit } = build();
    const page = await service.create('winter-rates', '  Winter rates ', actor);
    expect(page).toEqual({
      id: expect.any(String) as string,
      slug: 'winter-rates',
      title: 'Winter rates',
      status: 'draft',
      hasContent: false,
      sizeBytes: null,
      hasUnpublishedChanges: false,
      url: `${DOCS_BASE_URL}/winter-rates`,
      publishedAt: null,
      createdAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
    });
    expect(audit.entries).toEqual([
      {
        action: 'page.create',
        actor,
        targetType: 'public_page',
        targetId: page.id,
        metadata: { slug: 'winter-rates', title: 'Winter rates' },
      },
    ]);
  });

  it('rejects a duplicate slug with 409', async () => {
    const { service, audit } = build();
    await service.create('faq', 'FAQ', actor);
    await expect(service.create('faq', 'Other', actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(audit.entries).toHaveLength(1);
  });

  it('rethrows unexpected repository errors on create', async () => {
    const { service, repo } = build();
    jest.spyOn(repo, 'create').mockRejectedValue(new Error('db down'));
    await expect(service.create('faq', 'FAQ', actor)).rejects.toThrow(
      'db down',
    );
  });

  it('lists pages newest updatedAt first', async () => {
    const { service } = build();
    const a = await service.create('a', 'A', actor);
    const b = await service.create('b', 'B', actor);
    await service.updateTitle(a.id, 'A2', actor);
    const list = await service.list();
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('updates the title and audits before/after', async () => {
    const { service, audit } = build();
    const page = await service.create('faq', 'FAQ', actor);
    const updated = await service.updateTitle(page.id, 'Questions', actor);
    expect(updated.title).toBe('Questions');
    expect(updated.slug).toBe('faq');
    expect(audit.entries[1]).toMatchObject({
      action: 'page.update',
      targetId: page.id,
      metadata: {
        slug: 'faq',
        before: { title: 'FAQ' },
        after: { title: 'Questions' },
      },
    });
  });

  it('404s for an unknown page', async () => {
    const { service } = build();
    await expect(
      service.updateTitle(UNKNOWN_ID, 'x', actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.publish(UNKNOWN_ID, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s when the row disappears between load and save', async () => {
    const { service, repo } = build();
    const page = await service.create('faq', 'FAQ', actor);
    jest.spyOn(repo, 'update').mockResolvedValue(null);
    await expect(
      service.updateTitle(page.id, 'x', actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('uploadContent', () => {
    it('stores the draft and records size and sha256', async () => {
      const { service, storage, audit } = build();
      const page = await service.create('faq', 'FAQ', actor);
      const updated = await service.uploadContent(page.id, html, actor);
      expect(storage.objects.get('drafts/faq.html')).toEqual(html);
      expect(updated).toMatchObject({
        hasContent: true,
        sizeBytes: html.length,
        status: 'draft',
        hasUnpublishedChanges: false,
      });
      expect(audit.entries[1]).toMatchObject({
        action: 'page.upload',
        targetId: page.id,
        metadata: { slug: 'faq', sizeBytes: html.length, sha256: sha(html) },
      });
    });

    it('rejects an empty body with 400', async () => {
      const { service } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await expect(
        service.uploadContent(page.id, Buffer.alloc(0), actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a body above 2 MiB with 413', async () => {
      const { service, storage } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await expect(
        service.uploadContent(
          page.id,
          Buffer.alloc(PAGE_CONTENT_MAX_BYTES + 1),
          actor,
        ),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(storage.calls).toEqual([]);
    });

    it('leaves the row unchanged when the Worker fails', async () => {
      const { service, storage, repo, audit } = build();
      const page = await service.create('faq', 'FAQ', actor);
      const before = repo.snapshot();
      storage.failing = true;
      await expect(
        service.uploadContent(page.id, html, actor),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(repo.snapshot()).toEqual(before);
      expect(audit.entries).toHaveLength(1);
    });
  });

  describe('getContent', () => {
    it('returns the draft bytes', async () => {
      const { service } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await service.uploadContent(page.id, html, actor);
      await expect(service.getContent(page.id)).resolves.toEqual(html);
    });

    it('404s when nothing was uploaded', async () => {
      const { service } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await expect(service.getContent(page.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s when the Worker has no draft object', async () => {
      const { service, storage } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await service.uploadContent(page.id, html, actor);
      storage.objects.clear();
      await expect(service.getContent(page.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('publish', () => {
    it('400s without content', async () => {
      const { service, storage } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await expect(service.publish(page.id, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(storage.calls).toEqual([]);
    });

    it('copies the draft and sets the published fields', async () => {
      const { service, storage, audit } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await service.uploadContent(page.id, html, actor);
      const published = await service.publish(page.id, actor);
      expect(storage.objects.get('published/faq.html')).toEqual(html);
      expect(published).toMatchObject({
        status: 'published',
        hasUnpublishedChanges: false,
        url: `${DOCS_BASE_URL}/faq`,
      });
      expect(Date.parse(published.publishedAt!)).not.toBeNaN();
      expect(audit.entries[2]).toMatchObject({
        action: 'page.publish',
        targetId: page.id,
        metadata: { slug: 'faq', sha256: sha(html) },
      });
    });

    it('flags unpublished changes after a re-upload', async () => {
      const { service } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await service.uploadContent(page.id, html, actor);
      await service.publish(page.id, actor);
      const reuploaded = await service.uploadContent(
        page.id,
        Buffer.from('<h1>v2</h1>'),
        actor,
      );
      expect(reuploaded).toMatchObject({
        status: 'published',
        hasUnpublishedChanges: true,
      });
      const republished = await service.publish(page.id, actor);
      expect(republished.hasUnpublishedChanges).toBe(false);
    });

    it('502s when the draft object is missing from the Worker', async () => {
      const { service, storage, repo } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await service.uploadContent(page.id, html, actor);
      storage.objects.clear();
      const before = repo.snapshot();
      await expect(service.publish(page.id, actor)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      expect(repo.snapshot()).toEqual(before);
    });

    it('leaves the row unchanged when the Worker fails', async () => {
      const { service, storage, repo } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await service.uploadContent(page.id, html, actor);
      const before = repo.snapshot();
      storage.failing = true;
      await expect(service.publish(page.id, actor)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      expect(repo.snapshot()).toEqual(before);
    });
  });

  describe('unpublish', () => {
    it('removes the published object and returns to draft', async () => {
      const { service, storage, audit } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await service.uploadContent(page.id, html, actor);
      await service.publish(page.id, actor);
      const draft = await service.unpublish(page.id, actor);
      expect(storage.objects.has('published/faq.html')).toBe(false);
      expect(storage.objects.has('drafts/faq.html')).toBe(true);
      expect(draft).toMatchObject({
        status: 'draft',
        publishedAt: null,
        hasContent: true,
        hasUnpublishedChanges: false,
      });
      expect(audit.entries[3]).toMatchObject({
        action: 'page.unpublish',
        targetId: page.id,
        metadata: { slug: 'faq' },
      });
    });

    it('leaves the row unchanged when the Worker fails', async () => {
      const { service, storage, repo } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await service.uploadContent(page.id, html, actor);
      await service.publish(page.id, actor);
      const before = repo.snapshot();
      storage.failing = true;
      await expect(service.unpublish(page.id, actor)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      expect(repo.snapshot()).toEqual(before);
    });
  });

  describe('remove', () => {
    it('deletes both objects, then the row', async () => {
      const { service, storage, repo, audit } = build();
      const page = await service.create('faq', 'FAQ', actor);
      await service.uploadContent(page.id, html, actor);
      await service.publish(page.id, actor);
      storage.calls.length = 0;
      await service.remove(page.id, actor);
      expect(storage.calls).toEqual([
        'DELETE drafts/faq.html',
        'DELETE published/faq.html',
      ]);
      expect(storage.objects.size).toBe(0);
      expect(repo.rows.size).toBe(0);
      expect(audit.entries[3]).toMatchObject({
        action: 'page.delete',
        targetId: page.id,
        metadata: { slug: 'faq', title: 'FAQ' },
      });
    });

    it('keeps the row when the Worker fails', async () => {
      const { service, storage, repo, audit } = build();
      const page = await service.create('faq', 'FAQ', actor);
      storage.failing = true;
      await expect(service.remove(page.id, actor)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      expect(repo.rows.has(page.id)).toBe(true);
      expect(audit.entries).toHaveLength(1);
    });
  });
});
