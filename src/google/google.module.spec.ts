import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { GoogleAdminController } from './google.controller';
import { GoogleCalendarClient } from './google-calendar.client';

describe('GoogleModule', () => {
  it('boots inside the app without any Google env and stays off', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GOOGLE_')) {
        delete process.env[key];
      }
    }
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SUPABASE_CLIENT)
      .useValue({})
      .compile();

    expect(moduleRef.get(GoogleAdminController)).toBeInstanceOf(
      GoogleAdminController,
    );
    const client = moduleRef.get(GoogleCalendarClient);
    await expect(client.isConnected()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    await moduleRef.close();
  });
});
