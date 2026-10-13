import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { Checklist } from './documents.types';
import { MeDocumentsService } from './me-documents.service';

/** `/me/documents`: the calling instructor's onboarding checklist. */
@Controller('me/documents')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class MeDocumentsController {
  constructor(private readonly documents: MeDocumentsService) {}

  @Get()
  checklist(@CurrentUser() user: SupabaseJwtPayload): Promise<Checklist> {
    return this.documents.checklist(user.sub);
  }
}
