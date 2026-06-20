import { IsIn } from 'class-validator';
import type { UserRole } from '../admin.types';

/**
 * Body for `PATCH /admin/users/:id/role` (v1.x).
 * Promotes (`admin`) or demotes (`instructor`) a user by writing the
 * server-only `app_metadata.role`. `app_metadata` is never user-writable, so a
 * role can only change through this admin-gated route or the bootstrap script.
 */
export class UpdateRoleDto {
  @IsIn(['admin', 'instructor'])
  role!: UserRole;
}
