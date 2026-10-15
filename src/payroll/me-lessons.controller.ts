import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { MeLessonsService, type MyLessonsResponse } from './me-lessons.service';

@Controller('me/lessons')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class MeLessonsController {
  constructor(private readonly lessons: MeLessonsService) {}

  @Get()
  list(@CurrentUser() user: SupabaseJwtPayload): Promise<MyLessonsResponse> {
    return this.lessons.lessons(user.sub);
  }
}
