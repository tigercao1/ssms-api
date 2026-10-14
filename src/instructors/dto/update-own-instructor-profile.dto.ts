import { IsBoolean, IsOptional } from 'class-validator';
import { UpdateInstructorProfileDto } from './update-instructor-profile.dto';

/**
 * PATCH /me/instructor body: the shared profile fields plus whether a bio sent
 * in the same body is an unedited machine translation. Admin edits use the
 * base DTO, so these flags are rejected there.
 */
export class UpdateOwnInstructorProfileDto extends UpdateInstructorProfileDto {
  @IsOptional()
  @IsBoolean()
  bioEnMachineTranslated?: boolean;

  @IsOptional()
  @IsBoolean()
  bioZhMachineTranslated?: boolean;
}
