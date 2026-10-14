import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { CustomerSyncService } from '../customers/customer-sync.service';
import { CustomerSyncWorker } from '../customers/customer-sync.worker';
import {
  CustomersRepository,
  SupabaseCustomersRepository,
} from '../customers/customers.repository';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { InstructorCalendarsService } from './instructor-calendars.service';
import {
  LessonTypesRepository,
  SupabaseLessonTypesRepository,
} from './lesson-types.repository';
import {
  PayRatesRepository,
  SupabasePayRatesRepository,
} from './pay-rates.repository';
import { PayRatesService } from './pay-rates.service';

describe('Lessons and customers modules in the app', () => {
  const saved = process.env.CUSTOMER_SYNC_ENABLED;
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.CUSTOMER_SYNC_ENABLED;
    else process.env.CUSTOMER_SYNC_ENABLED = saved;
  });

  it('boots with customer sync off by default and calls neither Shopify, Google nor the database', async () => {
    delete process.env.CUSTOMER_SYNC_ENABLED;
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const supabase = { from: jest.fn(), rpc: jest.fn() };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SUPABASE_CLIENT)
      .useValue(supabase)
      .compile();
    await moduleRef.init();

    expect(moduleRef.get(LessonTypesRepository)).toBeInstanceOf(
      SupabaseLessonTypesRepository,
    );
    expect(moduleRef.get(PayRatesRepository)).toBeInstanceOf(
      SupabasePayRatesRepository,
    );
    expect(moduleRef.get(CustomersRepository)).toBeInstanceOf(
      SupabaseCustomersRepository,
    );
    expect(moduleRef.get(PayRatesService)).toBeInstanceOf(PayRatesService);
    expect(moduleRef.get(InstructorCalendarsService)).toBeInstanceOf(
      InstructorCalendarsService,
    );
    expect(moduleRef.get(CustomerSyncService).isEnabled()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalledWith('customers');
    expect(moduleRef.get(CustomerSyncWorker).scheduled()).toBe(false);
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      'try_lock_customer_sync',
      expect.anything(),
    );
    await moduleRef.close();
  });
});
