import { Module } from '@nestjs/common';
import { GoogleModule } from '../google/google.module';
import { MailerModule } from '../mailer/mailer.module';
import { AvailabilityService } from './availability.service';
import {
  BOOKING_CLOCK,
  BookingCalendarsService,
} from './booking-calendars.service';
import { BookingBatchService } from './booking-batch.service';
import { BookingEmailQueue } from './booking-email-queue';
import { BookingEmailsService } from './booking-emails.service';
import { BookingReminderSettingsService } from './booking-reminder-settings.service';
import { BookingRemindersController } from './booking-reminders.controller';
import {
  BookingRemindersRepository,
  SupabaseBookingRemindersRepository,
} from './booking-reminders.repository';
import { BookingRemindersWorker } from './booking-reminders.worker';
import { BookingController } from './booking.controller';
import {
  BookingRepository,
  SupabaseBookingRepository,
} from './booking.repository';
import { BookingService } from './booking.service';
import { BookingSettingsService } from './booking-settings.service';
import { CalendarSyncService } from './calendar-sync.service';
import { CalendarSyncWorker } from './calendar-sync.worker';

@Module({
  imports: [GoogleModule, MailerModule],
  controllers: [BookingController, BookingRemindersController],
  providers: [
    { provide: BookingRepository, useClass: SupabaseBookingRepository },
    { provide: BOOKING_CLOCK, useValue: { now: () => Date.now() } },
    BookingCalendarsService,
    BookingEmailQueue,
    BookingEmailsService,
    BookingSettingsService,
    AvailabilityService,
    BookingService,
    BookingBatchService,
    CalendarSyncService,
    CalendarSyncWorker,
    {
      provide: BookingRemindersRepository,
      useClass: SupabaseBookingRemindersRepository,
    },
    BookingReminderSettingsService,
    BookingRemindersWorker,
  ],
})
export class BookingModule {}
