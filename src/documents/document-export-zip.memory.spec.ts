import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import { writeSignedCopiesZip } from './document-export-zip';
import type { TemplateAssignmentDbRow } from './document-exports.types';
import { MULTIPART_PART_SIZE } from './multipart-upload';
import { R2PrivateStorageClient } from './private-storage.client';

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;

const MiB = 1024 * 1024;
const FILES = 200;
const FILE_BYTES = MiB;
const CHUNK = Buffer.alloc(64 * 1024, 0x25);
const LIMIT_BYTES = 64 * MiB;

const config = {
  get: (key: string) =>
    ({
      R2_ACCOUNT_ID: 'acct',
      R2_PRIVATE_BUCKET: 'ssms-private',
      R2_ACCESS_KEY_ID: 'id',
      R2_SECRET_ACCESS_KEY: 'secret',
    })[key],
} as unknown as ConfigService;

function row(i: number): TemplateAssignmentDbRow {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    status: 'completed',
    season: '2026/27',
    instructor_id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    first_name: `First${i}`,
    last_name: `Last${i}`,
    email: `i${i}@example.com`,
    signer_name: `First${i} Last${i}`,
    signer_email: `i${i}@example.com`,
    assigned_at: '2026-10-01T00:00:00Z',
    viewed_at: null,
    completed_at: '2026-10-02T15:00:00Z',
    signed_sha256: 'ab'.repeat(32),
    signed_key: `subjects/instructor/x/documents/${i}.pdf`,
    total_count: FILES,
  };
}

function pdfStream(onClose: () => void): Readable {
  let sent = 0;
  const stream = new Readable({
    read() {
      if (sent >= FILE_BYTES) {
        this.push(null);
        return;
      }
      sent += CHUNK.length;
      this.push(CHUNK);
    },
  });
  stream.once('close', onClose);
  return stream;
}

describe('signed-copies export memory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'export-memory-'));
  });

  const originalSend = Object.getOwnPropertyDescriptor(
    S3Client.prototype,
    'send',
  );

  afterEach(() => {
    if (originalSend) {
      Object.defineProperty(S3Client.prototype, 'send', originalSend);
    } else {
      delete (S3Client.prototype as { send?: unknown }).send;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it(`streams ${FILES} × 1 MiB copies through R2 multipart with bounded memory`, async () => {
    const zipPath = join(dir, 'export.zip');
    const fd = openSync(zipPath, 'w');
    let readsInFlight = 0;
    let maxReadsInFlight = 0;
    let partsInFlight = 0;
    let maxPartsInFlight = 0;
    const partSizes: number[] = [];
    let completedParts = 0;

    const fakeSend = async (command: unknown): Promise<unknown> => {
      if (command instanceof GetObjectCommand) {
        readsInFlight += 1;
        maxReadsInFlight = Math.max(maxReadsInFlight, readsInFlight);
        return {
          ContentLength: FILE_BYTES,
          Body: pdfStream(() => {
            readsInFlight -= 1;
          }),
        };
      }
      if (command instanceof CreateMultipartUploadCommand) {
        return { UploadId: 'upload-1' };
      }
      if (command instanceof UploadPartCommand) {
        const { PartNumber, Body } = command.input as {
          PartNumber: number;
          Body: Buffer;
        };
        partsInFlight += 1;
        maxPartsInFlight = Math.max(maxPartsInFlight, partsInFlight);
        partSizes[PartNumber - 1] = Body.length;
        await sleep(5);
        writeSync(
          fd,
          Body,
          0,
          Body.length,
          (PartNumber - 1) * MULTIPART_PART_SIZE,
        );
        partsInFlight -= 1;
        return { ETag: `"etag-${PartNumber}"` };
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        completedParts = command.input.MultipartUpload?.Parts?.length ?? 0;
        return {};
      }
      throw new Error('unexpected command');
    };
    S3Client.prototype.send = fakeSend as typeof S3Client.prototype.send;

    const storage = new R2PrivateStorageClient(config);
    const rows = Array.from({ length: FILES }, (_, i) => row(i));
    gc();
    const baseline = process.memoryUsage();
    const peak = { ...baseline };
    const live = { ...baseline };
    const sampleRaw = () => {
      const now = process.memoryUsage();
      peak.rss = Math.max(peak.rss, now.rss);
      peak.heapUsed = Math.max(peak.heapUsed, now.heapUsed);
      peak.arrayBuffers = Math.max(peak.arrayBuffers, now.arrayBuffers);
    };
    const sampleLive = async () => {
      gc();
      await new Promise((resolve) => setImmediate(resolve));
      const now = process.memoryUsage();
      live.heapUsed = Math.max(live.heapUsed, now.heapUsed);
      live.arrayBuffers = Math.max(live.arrayBuffers, now.arrayBuffers);
    };
    let sampling = true;
    const sampler = (async () => {
      for (let tick = 1; sampling; tick += 1) {
        sampleRaw();
        if (tick % 5 === 0) {
          await sampleLive();
        }
        await sleep(5);
      }
    })();
    const started = Date.now();
    let result: Awaited<ReturnType<typeof writeSignedCopiesZip>>;
    try {
      result = await writeSignedCopiesZip({
        storage,
        key: 'exports/memory.zip',
        folder: 'Agreement (2026-27)',
        rows,
      });
    } finally {
      sampling = false;
      await sampler;
      sampleRaw();
      closeSync(fd);
    }
    const mib = (bytes: number) => (bytes / MiB).toFixed(1);
    const growth = {
      rss: peak.rss - baseline.rss,
      heapUsed: peak.heapUsed - baseline.heapUsed,
      arrayBuffers: peak.arrayBuffers - baseline.arrayBuffers,
      liveHeapUsed: live.heapUsed - baseline.heapUsed,
      liveArrayBuffers: live.arrayBuffers - baseline.arrayBuffers,
    };
    process.stdout.write(
      `export memory: ${FILES} files, ${mib(result.sizeBytes)} MiB zip in ${Date.now() - started} ms; ` +
        `peak growth rss=${mib(growth.rss)} MiB, heapUsed=${mib(growth.heapUsed)} MiB ` +
        `(live after gc ${mib(growth.liveHeapUsed)} MiB), arrayBuffers=${mib(growth.arrayBuffers)} MiB ` +
        `(live after gc ${mib(growth.liveArrayBuffers)} MiB); max R2 reads in flight=${maxReadsInFlight}, ` +
        `max parts in flight=${maxPartsInFlight}\n`,
    );

    expect(result.fileCount).toBe(FILES);
    expect(result.skippedCount).toBe(0);
    expect(result.sizeBytes).toBeGreaterThan(FILES * FILE_BYTES);
    expect(growth.rss).toBeLessThan(LIMIT_BYTES);
    expect(growth.liveHeapUsed).toBeLessThan(LIMIT_BYTES);
    expect(maxReadsInFlight).toBeLessThanOrEqual(2);
    expect(maxPartsInFlight).toBeLessThanOrEqual(2);
    expect(completedParts).toBe(partSizes.length);
    expect(partSizes.slice(0, -1).every((n) => n === MULTIPART_PART_SIZE)).toBe(
      true,
    );
    expect(partSizes.reduce((a, b) => a + b, 0)).toBe(result.sizeBytes);
    expect(
      execFileSync('unzip', ['-tq', zipPath], { encoding: 'utf8' }),
    ).toContain('No errors detected');
  }, 120_000);
});
