import { Readable, Transform } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const PRIVATE_STORAGE_ENV = [
  'R2_ACCOUNT_ID',
  'R2_PRIVATE_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

export const PRIVATE_STORAGE_NOT_CONFIGURED =
  'Private storage is not configured';
export const UPLOAD_URL_TTL_SECONDS = 600;
export const DOWNLOAD_URL_TTL_SECONDS = 300;

/** A presigned URL and the moment it stops working (ISO 8601). */
export interface PresignedUrl {
  url: string;
  expiresAt: string;
}

/** Metadata returned by a HEAD request. */
export interface StoredObjectHead {
  contentLength: number;
  contentType: string | null;
}

/** Thrown when an object is larger than the caller's byte cap. */
export class ObjectTooLargeError extends Error {
  constructor(
    readonly key: string,
    readonly maxBytes: number,
  ) {
    super(`Object ${key} exceeds ${maxBytes} bytes`);
    this.name = 'ObjectTooLargeError';
  }
}

/**
 * Private object storage (Cloudflare R2 bucket `ssms-private`). Nothing in it is
 * public: callers authorise every request and hand out short-lived presigned
 * URLs only. Declared abstract so tests bind an in-memory fake.
 */
export abstract class PrivateStorageClient {
  /** Presigned PUT; the client must send exactly `contentType` and `contentLength`. */
  abstract presignPut(
    key: string,
    input: { contentType: string; contentLength: number; expiresIn?: number },
  ): Promise<PresignedUrl>;
  /** Presigned GET, optionally served as an attachment named `filename`. */
  abstract presignGet(
    key: string,
    input?: { expiresIn?: number; filename?: string },
  ): Promise<PresignedUrl>;
  /** HEAD; `null` when the object does not exist. */
  abstract head(key: string): Promise<StoredObjectHead | null>;
  /** Streams an object, failing with `ObjectTooLargeError` past `maxBytes`. `null` when missing. */
  abstract getStream(key: string, maxBytes: number): Promise<Readable | null>;
  /** Reads a whole object into memory, bounded by `maxBytes`. `null` when missing. */
  abstract getBuffer(key: string, maxBytes: number): Promise<Buffer | null>;
  abstract put(
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void>;
  abstract delete(key: string): Promise<void>;
}

interface R2Settings {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Collects a stream into one buffer. */
export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** Passes bytes through until more than `maxBytes` have flowed, then errors. */
export function byteCap(key: string, maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new ObjectTooLargeError(key, maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });
}

function isNotFound(err: unknown): boolean {
  const e = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/**
 * R2 implementation over the S3 API (`https://<account>.r2.cloudflarestorage.com`,
 * region `auto`). Credentials are read and validated on first use, so the API
 * still boots without them.
 */
@Injectable()
export class R2PrivateStorageClient extends PrivateStorageClient {
  private client: S3Client | null = null;
  private settings: R2Settings | null = null;

  constructor(private readonly config: ConfigService) {
    super();
  }

  async presignPut(
    key: string,
    input: { contentType: string; contentLength: number; expiresIn?: number },
  ): Promise<PresignedUrl> {
    const expiresIn = input.expiresIn ?? UPLOAD_URL_TTL_SECONDS;
    const { client, bucket } = this.connect();
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      }),
      {
        expiresIn,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return { url, expiresAt: this.expiry(expiresIn) };
  }

  async presignGet(
    key: string,
    input: { expiresIn?: number; filename?: string } = {},
  ): Promise<PresignedUrl> {
    const expiresIn = input.expiresIn ?? DOWNLOAD_URL_TTL_SECONDS;
    const { client, bucket } = this.connect();
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: input.filename
          ? `attachment; filename*=UTF-8''${encodeURIComponent(input.filename)}`
          : undefined,
      }),
      { expiresIn },
    );
    return { url, expiresAt: this.expiry(expiresIn) };
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const { client, bucket } = this.connect();
    try {
      const res = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return {
        contentLength: res.ContentLength ?? 0,
        contentType: res.ContentType ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  async getStream(key: string, maxBytes: number): Promise<Readable | null> {
    const { client, bucket } = this.connect();
    let res: GetObjectCommandOutput;
    try {
      res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
    const body = res.Body as Readable | undefined;
    if ((res.ContentLength ?? 0) > maxBytes) {
      body?.destroy();
      throw new ObjectTooLargeError(key, maxBytes);
    }
    return (body ?? Readable.from([])).pipe(byteCap(key, maxBytes));
  }

  async getBuffer(key: string, maxBytes: number): Promise<Buffer | null> {
    const stream = await this.getStream(key, maxBytes);
    return stream ? readAll(stream) : null;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const { client, bucket } = this.connect();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    const { client, bucket } = this.connect();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  private connect(): { client: S3Client; bucket: string } {
    if (!this.client || !this.settings) {
      const settings = this.readSettings();
      this.client = new S3Client({
        region: 'auto',
        forcePathStyle: true,
        endpoint: `https://${settings.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: settings.accessKeyId,
          secretAccessKey: settings.secretAccessKey,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
      this.settings = settings;
    }
    return { client: this.client, bucket: this.settings.bucket };
  }

  private readSettings(): R2Settings {
    const values = Object.fromEntries(
      PRIVATE_STORAGE_ENV.map((name) => [
        name,
        this.config.get<string>(name)?.trim() ?? '',
      ]),
    ) as Record<(typeof PRIVATE_STORAGE_ENV)[number], string>;
    const missing = PRIVATE_STORAGE_ENV.filter((name) => !values[name]);
    if (missing.length > 0) {
      throw new ServiceUnavailableException(
        `${PRIVATE_STORAGE_NOT_CONFIGURED}: missing ${missing.join(', ')}`,
      );
    }
    return {
      accountId: values.R2_ACCOUNT_ID,
      bucket: values.R2_PRIVATE_BUCKET,
      accessKeyId: values.R2_ACCESS_KEY_ID,
      secretAccessKey: values.R2_SECRET_ACCESS_KEY,
    };
  }

  private expiry(seconds: number): string {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
}
