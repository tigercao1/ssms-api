import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `PATCH /admin/instructors/:id/approval` (T6.4).
 *
 * Only the two terminal decisions are accepted here; `pending` is the initial
 * state and is never set via this route. The service enforces that the source
 * state is `pending` (valid transitions only). `reason` is optional context
 * for a rejection and is carried into the notification/audit metadata.
 */
export class UpdateApprovalStatusDto {
  @IsIn(['approved', 'rejected'])
  approvalStatus!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
