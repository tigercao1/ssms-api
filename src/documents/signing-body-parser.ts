import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { json } from 'express';

/** JSON body limit for completing a document: room for several signature PNGs. */
export const SIGNING_BODY_LIMIT = '4mb';
export const SIGNING_BODY_TOO_LARGE =
  'The signing request is larger than 4 MB; use smaller signature images';

const COMPLETE_PATH = /^\/me\/documents\/[^/]+\/complete\/?$/;
const parseSigningJson = json({ limit: SIGNING_BODY_LIMIT });

function toHttpError(err: unknown): Error {
  return (err as { status?: number }).status === 413
    ? new PayloadTooLargeException(SIGNING_BODY_TOO_LARGE)
    : new BadRequestException('Could not read request body');
}

/**
 * Parses `POST /me/documents/:id/complete` bodies with {@link SIGNING_BODY_LIMIT}
 * instead of the default 100 KB. Register it before the global body parser
 * (`app.use(signingBodyParser)` before `listen`/`init`); other routes pass through.
 */
export function signingBodyParser(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.method !== 'POST' || !COMPLETE_PATH.test(req.path)) {
    next();
    return;
  }
  parseSigningJson(req, res, (err?: unknown) => {
    next(err === undefined || err === null ? undefined : toHttpError(err));
  });
}
