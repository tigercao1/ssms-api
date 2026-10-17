import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DocumentRemindersAuthGuard } from './document-reminders-auth.guard';
import {
  DocumentRemindersService,
  type DailyRemindersResult,
} from './document-reminders.service';

/** `POST /internal/documents/reminders`: the daily reminder job, run by hand as a fallback to the in-app schedule. */
@Controller('internal/documents')
export class InternalDocumentsController {
  constructor(private readonly reminders: DocumentRemindersService) {}

  @Post('reminders')
  @HttpCode(HttpStatus.OK)
  @UseGuards(DocumentRemindersAuthGuard)
  runReminders(): Promise<DailyRemindersResult> {
    return this.reminders.run();
  }
}
