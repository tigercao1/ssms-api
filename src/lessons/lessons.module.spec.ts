import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { CreditsService } from './credits.service';
import { LessonProductSyncService } from './lesson-product-sync.service';
import { LessonProductsController } from './lesson-products.controller';
import {
  LessonProductsRepository,
  SupabaseLessonProductsRepository,
} from './lesson-products.repository';

describe('LessonsModule in the app', () => {
  const saved = process.env.LESSON_PRODUCT_SYNC_ENABLED;
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.LESSON_PRODUCT_SYNC_ENABLED;
    else process.env.LESSON_PRODUCT_SYNC_ENABLED = saved;
  });

  it('boots with sync off by default and touches neither Shopify nor the database', async () => {
    delete process.env.LESSON_PRODUCT_SYNC_ENABLED;
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const supabase = { from: jest.fn(), rpc: jest.fn() };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SUPABASE_CLIENT)
      .useValue(supabase)
      .compile();
    await moduleRef.init();

    expect(moduleRef.get(LessonProductsController)).toBeInstanceOf(
      LessonProductsController,
    );
    expect(moduleRef.get(LessonProductsRepository)).toBeInstanceOf(
      SupabaseLessonProductsRepository,
    );
    expect(moduleRef.get(LessonProductSyncService).isEnabled()).toBe(false);
    expect(moduleRef.get(CreditsService)).toBeInstanceOf(CreditsService);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      'sync_lesson_products',
      expect.anything(),
    );
    await moduleRef.close();
  });
});
