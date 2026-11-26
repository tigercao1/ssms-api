import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  check,
  type DbResult,
  hasCode,
  PG_UNIQUE_VIOLATION,
} from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { DOCUMENT_ASSIGNMENTS_TABLE } from './document-assignments.repository';
import { DOCUMENT_TEMPLATES_TABLE } from './document-templates.repository';
import type {
  ImportedSignatureRow,
  NewImportedSignature,
} from './jotform-imports.types';

const JOTFORM_SOURCE = 'jotform';

export abstract class JotformImportsRepository {
  abstract findImported(
    submissionId: string,
  ): Promise<ImportedSignatureRow | null>;
  abstract formTemplateId(slug: string): Promise<string | null>;
  abstract customerForEmail(
    email: string,
    firstName: string | null,
    lastName: string | null,
  ): Promise<string>;
  /** `false` when the submission was already imported. */
  abstract insertImported(row: NewImportedSignature): Promise<boolean>;
}

@Injectable()
export class SupabaseJotformImportsRepository extends JotformImportsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async findImported(
    submissionId: string,
  ): Promise<ImportedSignatureRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_ASSIGNMENTS_TABLE)
      .select('id, subject_id, signed_sha256')
      .eq('source', JOTFORM_SOURCE)
      .eq('external_id', submissionId)
      .maybeSingle()) as DbResult<ImportedSignatureRow>;
    check(error, 'find imported Jotform signature');
    return data;
  }

  async formTemplateId(slug: string): Promise<string | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .select('id')
      .eq('slug', slug)
      .eq('kind', 'form')
      .maybeSingle()) as DbResult<{ id: string }>;
    check(error, 'load form template');
    return data?.id ?? null;
  }

  async customerForEmail(
    email: string,
    firstName: string | null,
    lastName: string | null,
  ): Promise<string> {
    const { data, error } = (await this.supabase.rpc(
      'waiver_customer_for_email',
      { p_email: email, p_first_name: firstName, p_last_name: lastName },
    )) as DbResult<string>;
    check(error, 'match waiver customer');
    if (!data) {
      throw new Error('Failed to match waiver customer: no id returned');
    }
    return data;
  }

  async insertImported(row: NewImportedSignature): Promise<boolean> {
    const { error } = await this.supabase
      .from(DOCUMENT_ASSIGNMENTS_TABLE)
      .insert({
        ...row,
        subject_type: 'customer',
        status: 'completed',
        source: JOTFORM_SOURCE,
      });
    try {
      check(error, 'record imported Jotform signature');
    } catch (err) {
      if (hasCode(err, PG_UNIQUE_VIOLATION)) {
        return false;
      }
      throw err;
    }
    return true;
  }
}
