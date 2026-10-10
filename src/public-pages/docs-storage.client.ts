import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const DEFAULT_DOCS_WORKER_URL = 'https://docs.ssnow.club';
export const DOCS_WORKER_TIMEOUT_MS = 10_000;
export const DOCS_STORAGE_UNAVAILABLE = 'Docs storage is unavailable';
export const DOCS_STORAGE_NOT_CONFIGURED = 'Docs storage is not configured';

export abstract class DocsStorageClient {
  abstract isConfigured(): boolean;
  abstract publicUrl(slug: string): string;
  abstract put(key: string, body: Buffer): Promise<void>;
  abstract get(key: string): Promise<Buffer | null>;
  abstract delete(key: string): Promise<void>;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

@Injectable()
export class HttpDocsStorageClient extends DocsStorageClient {
  private readonly logger = new Logger(HttpDocsStorageClient.name);

  constructor(private readonly config: ConfigService) {
    super();
  }

  private get workerUrl(): string {
    return trimTrailingSlash(
      this.config.get<string>('DOCS_WORKER_URL') || DEFAULT_DOCS_WORKER_URL,
    );
  }

  private get token(): string | undefined {
    return this.config.get<string>('DOCS_INTERNAL_TOKEN') || undefined;
  }

  isConfigured(): boolean {
    return this.token !== undefined;
  }

  publicUrl(slug: string): string {
    const base =
      this.config.get<string>('DOCS_PUBLIC_BASE_URL') || this.workerUrl;
    return `${trimTrailingSlash(base)}/${slug}`;
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.request('PUT', key, {
      body: Uint8Array.from(body),
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.request('GET', key, {}, [404]);
    if (res.status === 404) {
      return null;
    }
    try {
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw this.unavailable('GET', key, (err as Error).message);
    }
  }

  async delete(key: string): Promise<void> {
    await this.request('DELETE', key, {}, [404]);
  }

  private async request(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    init: { body?: BodyInit; headers?: Record<string, string> },
    allowedStatuses: number[] = [],
  ): Promise<Response> {
    const token = this.token;
    if (token === undefined) {
      throw new ServiceUnavailableException(DOCS_STORAGE_NOT_CONFIGURED);
    }
    let res: Response;
    try {
      res = await fetch(`${this.workerUrl}/_internal/objects/${key}`, {
        method,
        body: init.body,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(DOCS_WORKER_TIMEOUT_MS),
      });
    } catch (err) {
      throw this.unavailable(method, key, (err as Error).message);
    }
    if (!res.ok && !allowedStatuses.includes(res.status)) {
      throw this.unavailable(method, key, `status ${res.status}`);
    }
    return res;
  }

  private unavailable(
    method: string,
    key: string,
    reason: string,
  ): BadGatewayException {
    this.logger.error(`Docs Worker ${method} ${key} failed: ${reason}`);
    return new BadGatewayException(DOCS_STORAGE_UNAVAILABLE);
  }
}
