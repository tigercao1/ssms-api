import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { raw, type Request, type Response } from 'express';
import type { Observable } from 'rxjs';
import { PAGE_CONTENT_MAX_BYTES } from './public-pages.types';
import { PAGE_CONTENT_TOO_LARGE } from './public-pages.service';

const parseRawHtml = raw({
  type: 'text/html',
  limit: PAGE_CONTENT_MAX_BYTES,
});

@Injectable()
export class RawHtmlBodyInterceptor implements NestInterceptor {
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    await new Promise<void>((resolve, reject) => {
      parseRawHtml(req, res, (err?: unknown) => {
        if (err === undefined || err === null) {
          resolve();
          return;
        }
        reject(toHttpError(err));
      });
    });
    if (!Buffer.isBuffer(req.body)) {
      throw new UnsupportedMediaTypeException('Content-Type must be text/html');
    }
    return next.handle();
  }
}

function toHttpError(err: unknown): Error {
  const status = (err as { status?: number }).status;
  if (status === 413) {
    return new PayloadTooLargeException(PAGE_CONTENT_TOO_LARGE);
  }
  if (status === 415) {
    return new UnsupportedMediaTypeException((err as Error).message);
  }
  return new BadRequestException('Could not read request body');
}
