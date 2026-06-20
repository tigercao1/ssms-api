import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { SUPABASE_CLIENT } from './database/supabase-client.token';
import { InstructorsController } from './instructors/instructors.controller';
import { MediaController } from './media/media.controller';

describe('AppModule bootstrap', () => {
  it('compiles the full DI graph with Instructors + Media wired in', async () => {
    process.env.SUPABASE_URL = 'http://localhost';
    process.env.SUPABASE_SECRET_KEY = 'test';
    process.env.SUPABASE_STORAGE_BUCKET = 'instructor-public';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Replace the real Supabase client so no network/secret is needed.
      .overrideProvider(SUPABASE_CLIENT)
      .useValue({})
      .compile();

    // Both feature controllers resolve from the compiled app graph.
    expect(moduleRef.get(InstructorsController)).toBeInstanceOf(
      InstructorsController,
    );
    expect(moduleRef.get(MediaController)).toBeInstanceOf(MediaController);
    await moduleRef.close();
  });
});
