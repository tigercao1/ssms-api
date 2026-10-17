import type { Readable } from 'node:stream';

/** S3 minimum part size; every part but the last is exactly this long. */
export const MULTIPART_PART_SIZE = 5 * 1024 * 1024;
/** Parts uploading at once; reading the body pauses while this many are in flight. */
export const MULTIPART_MAX_IN_FLIGHT = 2;

/** One uploaded part, as `CompleteMultipartUpload` needs it. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** The storage calls a multipart upload is made of. */
export interface MultipartTarget {
  start(): Promise<string>;
  uploadPart(
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string>;
  complete(uploadId: string, parts: UploadedPart[]): Promise<void>;
  abort(uploadId: string): Promise<void>;
}

export interface MultipartOptions {
  partSize?: number;
  maxInFlight?: number;
}

/**
 * Uploads `body` in fixed-size parts with at most `maxInFlight` parts in
 * flight, so memory stays near `(maxInFlight + 1) * partSize` whatever the
 * body's length. Aborts the upload and rethrows on any failure. Resolves to
 * the number of bytes uploaded.
 */
export async function uploadInParts(
  body: Readable,
  target: MultipartTarget,
  options: MultipartOptions = {},
): Promise<number> {
  const partSize = options.partSize ?? MULTIPART_PART_SIZE;
  const maxInFlight = options.maxInFlight ?? MULTIPART_MAX_IN_FLIGHT;
  const uploadId = await target.start();
  const parts: UploadedPart[] = [];
  const inFlight = new Set<Promise<void>>();
  const errors: Error[] = [];
  let total = 0;
  let partNumber = 0;
  let buffer = Buffer.allocUnsafe(partSize);
  let filled = 0;

  const send = (bytes: Buffer): void => {
    partNumber += 1;
    const number = partNumber;
    const task = target
      .uploadPart(uploadId, number, bytes)
      .then((etag) => {
        parts.push({ partNumber: number, etag });
      })
      .catch((err: unknown) => {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  };

  try {
    for await (const chunk of body) {
      let data = chunk as Buffer;
      total += data.length;
      while (data.length > 0) {
        const take = Math.min(partSize - filled, data.length);
        data.copy(buffer, filled, 0, take);
        filled += take;
        data = data.subarray(take);
        if (filled === partSize) {
          send(buffer);
          buffer = Buffer.allocUnsafe(partSize);
          filled = 0;
          while (inFlight.size >= maxInFlight) {
            await Promise.race(inFlight);
          }
          if (errors.length > 0) {
            throw errors[0];
          }
        }
      }
    }
    if (filled > 0 || partNumber === 0) {
      send(buffer.subarray(0, filled));
    }
    await Promise.all(inFlight);
    if (errors.length > 0) {
      throw errors[0];
    }
    parts.sort((a, b) => a.partNumber - b.partNumber);
    await target.complete(uploadId, parts);
    return total;
  } catch (err) {
    body.destroy();
    await Promise.allSettled(inFlight);
    await target.abort(uploadId).catch(() => undefined);
    throw err;
  }
}
