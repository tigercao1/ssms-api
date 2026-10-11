import {
  type ArgumentsHost,
  BadGatewayException,
  Catch,
  ConflictException,
  type ExceptionFilter,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleError,
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
} from './google.errors';

export const GOOGLE_NOT_CONFIGURED = 'Google is not configured';
export const GOOGLE_NOT_CONNECTED = 'Google Calendar is not connected';
export const GOOGLE_UNAVAILABLE = 'Google Calendar request failed';

@Catch(GoogleError)
export class GoogleErrorFilter implements ExceptionFilter<GoogleError> {
  private readonly logger = new Logger(GoogleErrorFilter.name);

  catch(error: GoogleError, host: ArgumentsHost): void {
    const exception = this.toHttp(error);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(exception.getStatus())
      .json(exception.getResponse());
  }

  private toHttp(error: GoogleError): HttpException {
    if (error instanceof GoogleNotConfiguredError) {
      return new ServiceUnavailableException(GOOGLE_NOT_CONFIGURED);
    }
    if (error instanceof GoogleNotConnectedError) {
      return new ConflictException(GOOGLE_NOT_CONNECTED);
    }
    if (error instanceof GoogleApiError || error instanceof GoogleAuthError) {
      this.logger.error(error.message);
      return new BadGatewayException(GOOGLE_UNAVAILABLE);
    }
    this.logger.error(error.message);
    return new ServiceUnavailableException(GOOGLE_UNAVAILABLE);
  }
}
