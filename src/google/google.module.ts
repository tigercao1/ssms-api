import { Module } from '@nestjs/common';
import {
  GoogleAdminController,
  GoogleOAuthCallbackController,
} from './google.controller';
import { GoogleCalendarClient } from './google-calendar.client';
import {
  GoogleConnectionRepository,
  SupabaseGoogleConnectionRepository,
} from './google-connection.repository';
import { GoogleConnectionService } from './google-connection.service';
import { GoogleOAuthClient } from './google-oauth.client';

@Module({
  controllers: [GoogleAdminController, GoogleOAuthCallbackController],
  providers: [
    GoogleOAuthClient,
    GoogleCalendarClient,
    GoogleConnectionService,
    {
      provide: GoogleConnectionRepository,
      useClass: SupabaseGoogleConnectionRepository,
    },
  ],
  exports: [GoogleCalendarClient],
})
export class GoogleModule {}
