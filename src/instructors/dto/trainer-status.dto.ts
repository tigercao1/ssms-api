import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * One trainer-status row (CERTIFICATION_STRUCTURE.md § Trainers). Sparse — only
 * include disciplines the instructor actually trains. The DB enforces
 * UNIQUE(instructor_id, discipline) and the CHECK that a non-null trainer_level
 * requires rookie_session_completed = true.
 */
export class TrainerStatusDto {
  @IsIn(['ski', 'snowboard'])
  discipline!: 'ski' | 'snowboard';

  @IsOptional()
  @IsBoolean()
  rookieSessionCompleted?: boolean;

  /** CSIA only; informational for CASI. */
  @IsOptional()
  @IsBoolean()
  trainerExamPassed?: boolean;

  /** 1..4; null/omitted = not officially a trainer for this discipline. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  trainerLevel?: number | null;
}
