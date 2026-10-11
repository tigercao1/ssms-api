import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/** Error body Supabase Auth expects from an HTTP hook. */
export interface HookErrorBody {
  error: { http_code: number; message: string };
}

const INTERNAL_ERROR = 'Internal server error';

/**
 * Renders every error from a hook route in the Supabase auth hook format,
 * `{ "error": { "http_code": <status>, "message": "…" } }`, as
 * `application/json` with the same HTTP status.
 */
@Catch()
export class HookErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HookErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, message } = this.describe(exception);
    const body: HookErrorBody = { error: { http_code: status, message } };
    res.status(status).type('application/json').json(body);
  }

  private describe(exception: unknown): { status: number; message: string } {
    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        message: messageOf(exception),
      };
    }
    this.logger.error(
      `Unhandled hook error: ${(exception as Error)?.message ?? exception}`,
    );
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: INTERNAL_ERROR,
    };
  }
}

function messageOf(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) {
    return message.join('; ');
  }
  return typeof message === 'string' ? message : exception.message;
}
