import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { DocumentRemindersService } from './document-reminders.service';

/** `POST /admin/documents/assignments/:id/remind`: email one reminder now. */
@Controller('admin/documents/assignments')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminDocumentRemindersController {
  constructor(private readonly reminders: DocumentRemindersService) {}

  /** 202; the email is sent in the background. */
  @Post(':id/remind')
  @HttpCode(HttpStatus.ACCEPTED)
  remind(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    return this.reminders.remindOne(id, toActor(user, userAgent));
  }
}
