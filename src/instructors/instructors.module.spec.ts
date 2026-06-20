import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InstructorsModule } from './instructors.module';
import { InstructorsService } from './instructors.service';
import { TRANSLATION_QUEUE } from './translation-queue.port';
import { TranslationQueueService } from '../bio-translation/translation-queue.service';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

/** Stand-in for the @Global DatabaseModule so the DI graph can resolve. */
@Global()
@Module({
  providers: [{ provide: SUPABASE_CLIENT, useValue: {} }],
  exports: [SUPABASE_CLIENT],
})
class FakeDatabaseModule {}

describe('InstructorsModule wiring', () => {
  it('binds TRANSLATION_QUEUE to the real TranslationQueueService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDatabaseModule, InstructorsModule],
    }).compile();

    const service = moduleRef.get(InstructorsService);
    const queue = moduleRef.get<TranslationQueueService>(TRANSLATION_QUEUE);

    expect(service).toBeInstanceOf(InstructorsService);
    expect(queue).toBeInstanceOf(TranslationQueueService);
    await moduleRef.close();
  });
});
