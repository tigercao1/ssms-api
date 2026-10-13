import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { AvailabilityService } from './availability.service';
import { BOOKING_CLOCK, type BookingClock } from './booking-calendars.service';
import {
  BookingRepository,
  SupabaseBookingRepository,
} from './booking.repository';
import { BookingService } from './booking.service';

describe('Booking module in the app', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('wires the Supabase repository and a wall clock without calling Google', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SUPABASE_CLIENT)
      .useValue({ from: jest.fn(), rpc: jest.fn() })
      .compile();
    await moduleRef.init();

    expect(moduleRef.get(BookingRepository)).toBeInstanceOf(
      SupabaseBookingRepository,
    );
    expect(moduleRef.get(BookingService)).toBeInstanceOf(BookingService);
    expect(moduleRef.get(AvailabilityService)).toBeInstanceOf(
      AvailabilityService,
    );
    const clock = moduleRef.get<BookingClock>(BOOKING_CLOCK);
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});
