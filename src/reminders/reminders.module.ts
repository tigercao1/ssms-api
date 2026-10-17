import { Module } from '@nestjs/common';
import { ActivationModule } from '../activation/activation.module';
import { DocumentsModule } from '../documents/documents.module';
import { SeasonsModule } from '../seasons/seasons.module';
import {
  DailyReminderRunsRepository,
  SupabaseDailyReminderRunsRepository,
} from './daily-reminder-runs.repository';
import { DailyRemindersWorker } from './daily-reminders.worker';

@Module({
  imports: [DocumentsModule, ActivationModule, SeasonsModule],
  providers: [
    {
      provide: DailyReminderRunsRepository,
      useClass: SupabaseDailyReminderRunsRepository,
    },
    DailyRemindersWorker,
  ],
})
export class RemindersModule {}
