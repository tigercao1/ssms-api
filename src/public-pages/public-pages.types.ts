export const PAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PAGE_SLUG_MAX_LENGTH = 80;
export const PAGE_TITLE_MAX_LENGTH = 200;
export const PAGE_CONTENT_MAX_BYTES = 2_097_152;

export type PublicPageStatus = 'draft' | 'published';

export interface PublicPage {
  id: string;
  slug: string;
  title: string;
  status: PublicPageStatus;
  hasContent: boolean;
  sizeBytes: number | null;
  hasUnpublishedChanges: boolean;
  url: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicPageRow {
  id: string;
  slug: string;
  title: string;
  status: PublicPageStatus;
  draft_sha256: string | null;
  draft_size_bytes: number | null;
  published_sha256: string | null;
  published_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export const draftKey = (slug: string): string => `drafts/${slug}.html`;
export const publishedKey = (slug: string): string => `published/${slug}.html`;
