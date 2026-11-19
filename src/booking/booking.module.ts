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
  controllers: [BookingController],
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
  ],
})
export class BookingModule {}
