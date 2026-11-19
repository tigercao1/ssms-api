import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import {
  type CountedResult,
  type PageRequest,
  PGRST_RANGE_NOT_SATISFIABLE,
  type RowPage,
} from '../database/pagination';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import {
  BUG_REPORT_STATUSES,
  type BugReportRow,
  type BugReportStatus,
  type NewBugReport,
  type SubmitOutcome,
} from './bug-reports.types';

const TABLE = 'bug_reports';

export interface SubmitLimits {
  hourlyPerReporter: number;
  perMinute: number;
}

export type BugReportPatch = Partial<
  Pick<BugReportRow, 'status' | 'admin_note'>
>;

interface SubmitRow {
  id: string | null;
  created_at: string | null;
  limited: 'reporter' | 'global' | null;
}

function statusFilter(status: BugReportStatus | undefined): readonly string[] {
  return status ? [status] : BUG_REPORT_STATUSES;
}

export abstract class BugReportsRepository {
  abstract instructorName(authUserId: string): Promise<string | null>;
  abstract submit(
    report: NewBugReport,
    limits: SubmitLimits,
  ): Promise<SubmitOutcome>;
  abstract list(
    status: BugReportStatus | undefined,
    page: PageRequest,
  ): Promise<RowPage<BugReportRow>>;
  abstract findById(id: string): Promise<BugReportRow | null>;
  abstract update(
    id: string,
    expectedStatus: BugReportStatus,
    patch: BugReportPatch,
  ): Promise<BugReportRow | null>;
}

@Injectable()
export class SupabaseBugReportsRepository extends BugReportsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async instructorName(authUserId: string): Promise<string | null> {
    const { data, error } = (await this.supabase
      .from('instructors')
      .select('display_name_en, first_name, last_name')
      .eq('auth_user_id', authUserId)
      .maybeSingle()) as DbResult<{
      display_name_en: string | null;
      first_name: string | null;
      last_name: string | null;
    }>;
    check(error, 'read reporter name');
    const fullName = [data?.first_name, data?.last_name]
      .filter(Boolean)
      .join(' ');
    return data?.display_name_en?.trim() || fullName.trim() || null;
  }

  async submit(
    report: NewBugReport,
    limits: SubmitLimits,
  ): Promise<SubmitOutcome> {
    const { data, error } = (await this.supabase
      .rpc('submit_bug_report', {
        p_report: report,
        p_hourly_limit_per_reporter: limits.hourlyPerReporter,
        p_minute_limit: limits.perMinute,
      })
      .single()) as DbResult<SubmitRow>;
    check(error, 'submit bug report');
    if (!data?.id || !data.created_at) {
      return { limited: data?.limited ?? 'global' };
    }
    return { id: data.id, createdAt: data.created_at };
  }

  async list(
    status: BugReportStatus | undefined,
    { limit, offset }: PageRequest,
  ): Promise<RowPage<BugReportRow>> {
    const { data, error, count } = (await this.supabase
      .from(TABLE)
      .select('*', { count: 'exact' })
      .in('status', statusFilter(status))
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)) as CountedResult<BugReportRow[]>;
    if (error?.code === PGRST_RANGE_NOT_SATISFIABLE) {
      return { rows: [], total: await this.count(status) };
    }
    check(error, 'list bug reports');
    return { rows: data ?? [], total: count ?? 0 };
  }

  private async count(status: BugReportStatus | undefined): Promise<number> {
    const { error, count } = (await this.supabase
      .from(TABLE)
      .select('id', { count: 'exact', head: true })
      .in('status', statusFilter(status))) as CountedResult<null>;
    check(error, 'count bug reports');
    return count ?? 0;
  }

  async findById(id: string): Promise<BugReportRow | null> {
    const { data, error } = (await this.supabase
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle()) as DbResult<BugReportRow>;
    check(error, 'read bug report');
    return data;
  }

  async update(
    id: string,
    expectedStatus: BugReportStatus,
    patch: BugReportPatch,
  ): Promise<BugReportRow | null> {
    const { data, error } = (await this.supabase
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('status', expectedStatus)
      .select('*')
      .maybeSingle()) as DbResult<BugReportRow>;
    check(error, 'update bug report');
    return data;
  }
}
