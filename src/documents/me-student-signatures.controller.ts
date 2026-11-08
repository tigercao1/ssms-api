import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { StudentSignaturesQueryDto } from './dto/form.dto';
import type { StudentSignature } from './form-templates.types';
import { SignatureLookupsService } from './signature-lookups.service';

/** `GET /me/students/signatures?q=`: whether the caller's own students signed a waiver, by name. */
@Controller('me/students/signatures')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class MeStudentSignaturesController {
  constructor(private readonly lookups: SignatureLookupsService) {}

  @Get()
  list(
    @Query() query: StudentSignaturesQueryDto,
    @CurrentUser() user: SupabaseJwtPayload,
  ): Promise<StudentSignature[]> {
    return this.lookups.students(user.sub, query.q);
  }
}
