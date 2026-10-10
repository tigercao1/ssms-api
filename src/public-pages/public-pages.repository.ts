import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type { PublicPageRow } from './public-pages.types';

export const PUBLIC_PAGES_TABLE = 'public_pages';
export const PUBLIC_PAGE_COLUMNS =
  'id, slug, title, status, draft_sha256, draft_size_bytes, published_sha256, published_at, created_by, updated_by, created_at, updated_at';

export class DuplicateSlugError extends Error {
  constructor(slug: string) {
    super(`Slug '${slug}' is already taken`);
  }
}

export interface CreatePublicPageInput {
  slug: string;
  title: string;
  userId: string | null;
}

export interface PublicPagePatch {
  title?: string;
  status?: PublicPageRow['status'];
  draft_sha256?: string;
  draft_size_bytes?: number;
  published_sha256?: string | null;
  published_at?: string | null;
}

export abstract class PublicPagesRepository {
  abstract list(): Promise<PublicPageRow[]>;
  abstract findById(id: string): Promise<PublicPageRow | null>;
  abstract create(input: CreatePublicPageInput): Promise<PublicPageRow>;
  abstract update(
    id: string,
    patch: PublicPagePatch,
    userId: string | null,
  ): Promise<PublicPageRow | null>;
  abstract delete(id: string): Promise<void>;
}

interface DbError {
  message: string;
  code?: string;
}

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class SupabasePublicPagesRepository extends PublicPagesRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async list(): Promise<PublicPageRow[]> {
    const { data, error } = (await this.supabase
      .from(PUBLIC_PAGES_TABLE)
      .select(PUBLIC_PAGE_COLUMNS)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: true })) as {
      data: PublicPageRow[] | null;
      error: DbError | null;
    };
    check(error, 'list public pages');
    return data ?? [];
  }

  async findById(id: string): Promise<PublicPageRow | null> {
    const { data, error } = (await this.supabase
      .from(PUBLIC_PAGES_TABLE)
      .select(PUBLIC_PAGE_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as { data: PublicPageRow | null; error: DbError | null };
    check(error, 'load public page');
    return data ?? null;
  }

  async create(input: CreatePublicPageInput): Promise<PublicPageRow> {
    const { data, error } = (await this.supabase
      .from(PUBLIC_PAGES_TABLE)
      .insert({
        slug: input.slug,
        title: input.title,
        created_by: input.userId,
        updated_by: input.userId,
      })
      .select(PUBLIC_PAGE_COLUMNS)
      .single()) as { data: PublicPageRow | null; error: DbError | null };
    if (error?.code === PG_UNIQUE_VIOLATION) {
      throw new DuplicateSlugError(input.slug);
    }
    check(error, 'create public page');
    if (!data) {
      throw new Error('Failed to create public page: no row returned');
    }
    return data;
  }

  async update(
    id: string,
    patch: PublicPagePatch,
    userId: string | null,
  ): Promise<PublicPageRow | null> {
    const { data, error } = (await this.supabase
      .from(PUBLIC_PAGES_TABLE)
      .update({ ...patch, updated_by: userId })
      .eq('id', id)
      .select(PUBLIC_PAGE_COLUMNS)
      .maybeSingle()) as { data: PublicPageRow | null; error: DbError | null };
    check(error, 'update public page');
    return data ?? null;
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.supabase
      .from(PUBLIC_PAGES_TABLE)
      .delete()
      .eq('id', id);
    check(error, 'delete public page');
  }
}

function check(error: DbError | null, action: string): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}
