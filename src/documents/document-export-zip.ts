import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import {
  csvLine,
  MANIFEST_HEADER,
  MANIFEST_NAME,
  manifestLine,
  type SkipReason,
  signedCopyBaseName,
  UniqueNames,
} from './document-export-files';
import type { TemplateAssignmentDbRow } from './document-exports.types';
import {
  ObjectTooLargeError,
  type PrivateStorageClient,
} from './private-storage.client';

/** Largest signed copy an export includes; bigger ones are listed as skipped. */
export const MAX_EXPORT_FILE_BYTES = 25 * 1024 * 1024;
export const EXPORT_CONTENT_TYPE = 'application/zip';

/** What an export wrote. */
export interface ExportZipResult {
  fileCount: number;
  skippedCount: number;
  sizeBytes: number;
}

interface OpenedCopy {
  row: TemplateAssignmentDbRow;
  stream: Readable | null;
  skip: SkipReason | null;
}

async function openCopy(
  storage: PrivateStorageClient,
  row: TemplateAssignmentDbRow,
): Promise<OpenedCopy> {
  if (!row.signed_key) {
    return { row, stream: null, skip: 'missing' };
  }
  try {
    const stream = await storage.getStream(
      row.signed_key,
      MAX_EXPORT_FILE_BYTES,
    );
    return stream
      ? { row, stream, skip: null }
      : { row, stream: null, skip: 'missing' };
  } catch (err) {
    if (err instanceof ObjectTooLargeError) {
      return { row, stream: null, skip: 'too large' };
    }
    throw err;
  }
}

/**
 * Streams the signed copies of `rows` into a store-mode ZIP under `folder`,
 * plus `manifest.csv`, straight into a multipart upload at `key`. Exactly one
 * copy is being written while at most the next one is being opened, so no
 * more than two R2 reads are in flight, and the upload's backpressure pauses
 * the copy being read. Missing and oversized copies are skipped and listed.
 */
export async function writeSignedCopiesZip(input: {
  storage: PrivateStorageClient;
  key: string;
  folder: string;
  rows: TemplateAssignmentDbRow[];
}): Promise<ExportZipResult> {
  const { storage, key, folder, rows } = input;
  const zip = new ZipFile();
  const upload = storage.uploadStream(
    key,
    zip.outputStream as Readable,
    EXPORT_CONTENT_TYPE,
  );
  const uploadFailed = new Promise<never>((_, reject) => {
    upload.catch(reject);
  });
  uploadFailed.catch(() => undefined);
  const names = new UniqueNames();
  let manifest = csvLine(MANIFEST_HEADER);
  let fileCount = 0;
  let skippedCount = 0;
  let active: Readable | null = null;
  let next: Promise<OpenedCopy> | null =
    rows.length > 0 ? openCopy(storage, rows[0]) : null;
  try {
    for (let i = 0; i < rows.length; i += 1) {
      const current: OpenedCopy = await Promise.race([
        next as Promise<OpenedCopy>,
        uploadFailed,
      ]);
      next = i + 1 < rows.length ? openCopy(storage, rows[i + 1]) : null;
      next?.catch(() => undefined);
      if (!current.stream) {
        skippedCount += 1;
        manifest += manifestLine(current.row, null, current.skip);
        continue;
      }
      const fileName = names.take(signedCopyBaseName(current.row), '.pdf');
      const stream = current.stream;
      active = stream;
      const done = finished(stream);
      done.catch(() => undefined);
      zip.addReadStreamLazy(
        `${folder}/${fileName}`,
        {
          compress: false,
          mtime: new Date(current.row.completed_at ?? Date.now()),
        },
        (cb) => cb(null, stream),
      );
      await Promise.race([done, uploadFailed]);
      active = null;
      fileCount += 1;
      manifest += manifestLine(current.row, `${folder}/${fileName}`, null);
    }
    zip.addBuffer(Buffer.from(manifest, 'utf8'), MANIFEST_NAME, {
      compress: false,
    });
    zip.end();
    const sizeBytes = await upload;
    return { fileCount, skippedCount, sizeBytes };
  } catch (err) {
    active?.destroy();
    const pending = await next?.catch(() => null);
    pending?.stream?.destroy();
    (zip.outputStream as Readable).destroy(
      err instanceof Error ? err : new Error(String(err)),
    );
    await upload.catch(() => undefined);
    throw err;
  }
}
