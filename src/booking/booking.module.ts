import { Module } from '@nestjs/common';
import { GoogleModule } from '../google/google.module';
import { AvailabilityService } from './availability.service';
import {
  BOOKING_CLOCK,
  BookingCalendarsService,
} from './booking-calendars.service';
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
  imports: [GoogleModule],
  controllers: [BookingController],
  providers: [
    { provide: BookingRepository, useClass: SupabaseBookingRepository },
    { provide: BOOKING_CLOCK, useValue: { now: () => Date.now() } },
    BookingCalendarsService,
    BookingSettingsService,
    AvailabilityService,
    BookingService,
    CalendarSyncService,
    CalendarSyncWorker,
  ],
})
export class BookingModule {}
