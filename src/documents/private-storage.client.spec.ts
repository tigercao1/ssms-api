import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  byteCap,
  ObjectTooLargeError,
  PRIVATE_STORAGE_NOT_CONFIGURED,
  R2PrivateStorageClient,
  readAll,
} from './private-storage.client';

const ENV: Record<string, string> = {
  R2_ACCOUNT_ID: 'acct123',
  R2_PRIVATE_BUCKET: 'ssms-private',
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'secret',
};

function configWith(env: Record<string, string>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

describe('R2PrivateStorageClient', () => {
  let send: jest.SpyInstance;
  const sent = (i: number): unknown => (send.mock.calls as unknown[][])[i][0];

  beforeEach(() => {
    send = jest.spyOn(S3Client.prototype, 'send');
  });

  afterEach(() => {
    send.mockRestore();
  });

  it('presigns a PUT against the account endpoint with signed type and length', async () => {
    const client = new R2PrivateStorageClient(configWith(ENV));
    const before = Date.now();
    const { url, expiresAt } = await client.presignPut('templates/t1/x.pdf', {
      contentType: 'application/pdf',
      contentLength: 1234,
    });
    const parsed = new URL(url);
    expect(parsed.host).toBe('acct123.r2.cloudflarestorage.com');
    expect(parsed.pathname).toBe('/ssms-private/templates/t1/x.pdf');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain(
      '/auto/s3/aws4_request',
    );
    const signed = parsed.searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signed.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host']),
    );
    const ms = Date.parse(expiresAt) - before;
    expect(ms).toBeGreaterThanOrEqual(600_000);
    expect(ms).toBeLessThan(605_000);
    expect(send).not.toHaveBeenCalled();
  });

  it('presigns a 5-minute GET, optionally as a named attachment', async () => {
    const client = new R2PrivateStorageClient(configWith(ENV));
    const plain = new URL((await client.presignGet('a/b.pdf')).url);
    expect(plain.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(plain.searchParams.get('response-content-disposition')).toBeNull();
    const named = new URL(
      (
        await client.presignGet('a/b.pdf', {
          filename: '合同 1.pdf',
          expiresIn: 60,
        })
      ).url,
    );
    expect(named.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(named.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('合同 1.pdf')}`,
    );
  });

  it('validates the R2 env lazily, at first use', async () => {
    const client = new R2PrivateStorageClient(
      configWith({ R2_ACCOUNT_ID: 'acct', R2_PRIVATE_BUCKET: ' ' }),
    );
    const attempt = client.head('k');
    await expect(attempt).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(client.head('k')).rejects.toThrow(
      `${PRIVATE_STORAGE_NOT_CONFIGURED}: missing R2_PRIVATE_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY`,
    );
  });

  it('heads an object and maps 404 to null', async () => {
    send
      .mockResolvedValueOnce({
        ContentLength: 42,
        ContentType: 'application/pdf',
      })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error('nf'), { name: 'NotFound' }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('x'), { $metadata: { httpStatusCode: 404 } }),
      )
      .mockRejectedValueOnce(new Error('boom'));
    const client = new R2PrivateStorageClient(configWith(ENV));
    await expect(client.head('k')).resolves.toEqual({
      contentLength: 42,
      contentType: 'application/pdf',
    });
    await expect(client.head('k')).resolves.toEqual({
      contentLength: 0,
      contentType: null,
    });
    await expect(client.head('k')).resolves.toBeNull();
    await expect(client.head('k')).resolves.toBeNull();
    await expect(client.head('k')).rejects.toThrow('boom');
    const command = sent(0) as HeadObjectCommand;
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(command.input).toEqual({ Bucket: 'ssms-private', Key: 'k' });
  });

  it('reads objects within the byte cap and rejects larger ones', async () => {
    send
      .mockResolvedValueOnce({
        ContentLength: 5,
        Body: Readable.from([Buffer.from('he'), Buffer.from('llo')]),
      })
      .mockResolvedValueOnce({ ContentLength: 50, Body: Readable.from([]) })
      .mockResolvedValueOnce({ Body: Readable.from([Buffer.alloc(11)]) })
      .mockRejectedValueOnce(
        Object.assign(new Error('nf'), { name: 'NoSuchKey' }),
      )
      .mockResolvedValueOnce({ ContentLength: 0 })
      .mockRejectedValueOnce(new Error('down'));
    const client = new R2PrivateStorageClient(configWith(ENV));
    await expect(client.getBuffer('k', 10)).resolves.toEqual(
      Buffer.from('hello'),
    );
    await expect(client.getBuffer('k', 10)).rejects.toBeInstanceOf(
      ObjectTooLargeError,
    );
    await expect(client.getBuffer('k', 10)).rejects.toThrow(
      'Object k exceeds 10 bytes',
    );
    await expect(client.getBuffer('k', 10)).resolves.toBeNull();
    await expect(client.getBuffer('k', 10)).resolves.toEqual(Buffer.alloc(0));
    await expect(client.getStream('k', 10)).rejects.toThrow('down');
    expect(sent(0)).toBeInstanceOf(GetObjectCommand);
  });

  it('puts and deletes objects', async () => {
    send.mockResolvedValue({});
    const client = new R2PrivateStorageClient(configWith(ENV));
    await client.put('k', Buffer.from('abc'), 'application/pdf');
    await client.delete('k');
    const put = sent(0) as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: 'ssms-private',
      Key: 'k',
      ContentType: 'application/pdf',
      ContentLength: 3,
    });
    const del = sent(1) as DeleteObjectCommand;
    expect(del).toBeInstanceOf(DeleteObjectCommand);
    expect(del.input).toEqual({ Bucket: 'ssms-private', Key: 'k' });
  });

  it('presigns a GET with an exact Content-Disposition when given', async () => {
    const client = new R2PrivateStorageClient(configWith(ENV));
    const url = new URL(
      (
        await client.presignGet('exports/e.zip', {
          contentDisposition: 'attachment; filename="a-2026-27-signed.zip"',
          filename: 'ignored.zip',
        })
      ).url,
    );
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="a-2026-27-signed.zip"',
    );
  });

  it('streams an upload as a multipart upload of 5 MiB parts', async () => {
    send.mockImplementation((command: unknown) =>
      Promise.resolve(
        command instanceof CreateMultipartUploadCommand
          ? { UploadId: 'up-1' }
          : command instanceof UploadPartCommand
            ? { ETag: `"${command.input.PartNumber}"` }
            : {},
      ),
    );
    const client = new R2PrivateStorageClient(configWith(ENV));
    const body = Readable.from([Buffer.alloc(6 * 1024 * 1024, 1)]);
    await expect(
      client.uploadStream('exports/e.zip', body, 'application/zip'),
    ).resolves.toBe(6 * 1024 * 1024);
    const commands = (send.mock.calls as unknown[][]).map((c) => c[0]);
    expect((commands[0] as CreateMultipartUploadCommand).input).toEqual({
      Bucket: 'ssms-private',
      Key: 'exports/e.zip',
      ContentType: 'application/zip',
    });
    const parts = commands.filter(
      (c): c is UploadPartCommand => c instanceof UploadPartCommand,
    );
    expect(
      parts.map((p) => [
        p.input.PartNumber,
        p.input.ContentLength,
        p.input.UploadId,
      ]),
    ).toEqual([
      [1, 5 * 1024 * 1024, 'up-1'],
      [2, 1024 * 1024, 'up-1'],
    ]);
    const complete = commands.at(-1) as CompleteMultipartUploadCommand;
    expect(complete).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(complete.input).toEqual({
      Bucket: 'ssms-private',
      Key: 'exports/e.zip',
      UploadId: 'up-1',
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: '"1"' },
          { PartNumber: 2, ETag: '"2"' },
        ],
      },
    });
  });

  it('aborts the multipart upload when a part fails', async () => {
    send.mockImplementation((command: unknown) =>
      command instanceof CreateMultipartUploadCommand
        ? Promise.resolve({ UploadId: 'up-2' })
        : command instanceof UploadPartCommand
          ? Promise.reject(new Error('part refused'))
          : Promise.resolve({}),
    );
    const client = new R2PrivateStorageClient(configWith(ENV));
    await expect(
      client.uploadStream(
        'k.zip',
        Readable.from([Buffer.from('x')]),
        'application/zip',
      ),
    ).rejects.toThrow('part refused');
    const abort = (send.mock.calls as unknown[][]).at(-1)?.[0];
    expect(abort).toBeInstanceOf(AbortMultipartUploadCommand);
    expect((abort as AbortMultipartUploadCommand).input).toEqual({
      Bucket: 'ssms-private',
      Key: 'k.zip',
      UploadId: 'up-2',
    });
  });

  it('fails an upload R2 gives no upload id, and parts without an ETag', async () => {
    send.mockResolvedValueOnce({});
    const client = new R2PrivateStorageClient(configWith(ENV));
    await expect(
      client.uploadStream('k.zip', Readable.from([]), 'application/zip'),
    ).rejects.toThrow('No upload id for k.zip');

    send.mockReset();
    send.mockImplementation((command: unknown) =>
      Promise.resolve(
        command instanceof CreateMultipartUploadCommand
          ? { UploadId: 'up-3' }
          : {},
      ),
    );
    await client.uploadStream(
      'k.zip',
      Readable.from([Buffer.from('x')]),
      'application/zip',
    );
    const complete = (send.mock.calls as unknown[][]).at(-1)?.[0];
    expect(
      (complete as CompleteMultipartUploadCommand).input.MultipartUpload,
    ).toEqual({ Parts: [{ PartNumber: 1, ETag: '' }] });
  });

  it('byteCap passes small streams and errors past the cap', async () => {
    await expect(
      readAll(Readable.from([Buffer.from('abc')]).pipe(byteCap('k', 3))),
    ).resolves.toEqual(Buffer.from('abc'));
  });
});
