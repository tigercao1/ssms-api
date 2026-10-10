import {
  type CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DOCS_STORAGE_NOT_CONFIGURED,
  DocsStorageClient,
} from './docs-storage.client';

@Injectable()
export class DocsStorageConfiguredGuard implements CanActivate {
  constructor(private readonly storage: DocsStorageClient) {}

  canActivate(): boolean {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException(DOCS_STORAGE_NOT_CONFIGURED);
    }
    return true;
  }
}
