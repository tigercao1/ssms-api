import { IsBoolean } from 'class-validator';

/**
 * Body for `PATCH /admin/instructors/:id/activation` (T6.5).
 * `isActive=false` hides the instructor from the public API (which filters on
 * `is_active = true`); `true` re-exposes them.
 */
export class UpdateActivationDto {
  @IsBoolean()
  isActive!: boolean;
}
