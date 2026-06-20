import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { ApprovalStatus } from '../admin.types';

/**
 * Query string for `GET /admin/instructors` (T6.3). Both filters are optional;
 * with neither, every instructor of every status is returned.
 */
export class ListInstructorsQueryDto {
  /** Narrow by approval workflow state. */
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: ApprovalStatus;

  /** Narrow by active flag. Accepts `true`/`false` (string or boolean). */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  active?: boolean;
}
