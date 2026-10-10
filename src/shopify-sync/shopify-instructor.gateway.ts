import { Injectable } from '@nestjs/common';
import { ShopifyAdminClient } from '../shopify/shopify-admin.client';
import { assertNoUserErrors } from '../shopify/shopify-user-errors';
import {
  type ShopifyUserError,
  ShopifyUserErrorsError,
} from '../shopify/shopify.errors';
import {
  type PublishableStatus,
  type ShopifyFieldInput,
  SSMS_INSTRUCTOR_TYPE,
} from './instructor-sync.types';

export interface ShopifyEntryRef {
  id: string;
  ssmsId: string | null;
}

export interface UpsertedEntry {
  id: string;
  handle: string;
}

export interface ShopifyFileRef {
  id: string;
  fileStatus: string;
}

export interface ShopifyFileState extends ShopifyFileRef {
  errors: string[];
}

const ENTRY_BY_HANDLE = `
  query SsmsInstructorByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) {
      id
      ssmsId: field(key: "ssms_id") { value }
    }
  }
`;

const UPSERT_ENTRY = `
  mutation SsmsInstructorUpsert(
    $handle: MetaobjectHandleInput!
    $metaobject: MetaobjectUpsertInput!
  ) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code }
    }
  }
`;

const CREATE_FILE = `
  mutation SsmsPhotoCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus }
      userErrors { field message code }
    }
  }
`;

const FILES_BY_NAME = `
  query SsmsPhotoByName($query: String!) {
    files(first: 10, query: $query) {
      nodes {
        id
        fileStatus
        ... on MediaImage { image { url } }
      }
    }
  }
`;

const FILE_STATUS = `
  query SsmsPhotoStatus($id: ID!) {
    node(id: $id) {
      ... on File {
        id
        fileStatus
        fileErrors { code message }
      }
    }
  }
`;

const DELETE_FILES = `
  mutation SsmsPhotoDelete($fileIds: [ID!]!) {
    fileDelete(fileIds: $fileIds) {
      deletedFileIds
      userErrors { field message code }
    }
  }
`;

const FILENAME_TAKEN = 'FILENAME_ALREADY_EXISTS';

interface UpsertPayload {
  metaobject: UpsertedEntry | null;
  userErrors: ShopifyUserError[];
}

@Injectable()
export class ShopifyInstructorGateway {
  constructor(private readonly shopify: ShopifyAdminClient) {}

  async findEntryByHandle(handle: string): Promise<ShopifyEntryRef | null> {
    const data = await this.shopify.graphql<{
      metaobjectByHandle: {
        id: string;
        ssmsId: { value: string | null } | null;
      } | null;
    }>(ENTRY_BY_HANDLE, { handle: { type: SSMS_INSTRUCTOR_TYPE, handle } });
    const entry = data.metaobjectByHandle;
    return entry ? { id: entry.id, ssmsId: entry.ssmsId?.value ?? null } : null;
  }

  async upsertEntry(
    handle: string,
    fields: ShopifyFieldInput[],
    status: PublishableStatus,
  ): Promise<UpsertedEntry> {
    return this.upsert(handle, {
      fields,
      capabilities: { publishable: { status } },
    });
  }

  async setEntryStatus(
    handle: string,
    status: PublishableStatus,
  ): Promise<UpsertedEntry> {
    return this.upsert(handle, { capabilities: { publishable: { status } } });
  }

  private async upsert(
    handle: string,
    metaobject: Record<string, unknown>,
  ): Promise<UpsertedEntry> {
    const data = await this.shopify.graphql<{
      metaobjectUpsert: UpsertPayload;
    }>(UPSERT_ENTRY, {
      handle: { type: SSMS_INSTRUCTOR_TYPE, handle },
      metaobject,
    });
    const payload = assertNoUserErrors(
      'metaobjectUpsert',
      data.metaobjectUpsert,
    );
    if (!payload.metaobject) {
      throw new Error('metaobjectUpsert returned no metaobject');
    }
    return payload.metaobject;
  }

  async createImage(
    originalSource: string,
    filename: string,
  ): Promise<ShopifyFileRef> {
    const data = await this.shopify.graphql<{
      fileCreate: {
        files: ShopifyFileRef[] | null;
        userErrors: ShopifyUserError[];
      } | null;
    }>(CREATE_FILE, {
      files: [
        {
          originalSource,
          filename,
          contentType: 'IMAGE',
          duplicateResolutionMode: 'RAISE_ERROR',
        },
      ],
    });
    const errors = data.fileCreate?.userErrors ?? [];
    if (errors.length > 0 && errors.every((e) => e.code === FILENAME_TAKEN)) {
      const existing = await this.findImageByName(filename);
      if (existing) {
        return existing;
      }
      throw new ShopifyUserErrorsError('fileCreate', errors);
    }
    const payload = assertNoUserErrors('fileCreate', data.fileCreate);
    const [file] = payload.files ?? [];
    if (!file) {
      throw new Error('fileCreate returned no file');
    }
    return file;
  }

  async findImageByName(filename: string): Promise<ShopifyFileRef | null> {
    const data = await this.shopify.graphql<{
      files: {
        nodes: (ShopifyFileRef & { image?: { url: string } | null })[];
      };
    }>(FILES_BY_NAME, { query: `filename:"${filename}"` });
    const nodes = data.files.nodes;
    const match =
      nodes.find((n) => n.image?.url.split('?')[0].endsWith(`/${filename}`)) ??
      (nodes.length === 1 ? nodes[0] : undefined);
    return match ? { id: match.id, fileStatus: match.fileStatus } : null;
  }

  async fileState(id: string): Promise<ShopifyFileState | null> {
    const data = await this.shopify.graphql<{
      node: {
        id: string;
        fileStatus: string;
        fileErrors: { code: string; message: string }[] | null;
      } | null;
    }>(FILE_STATUS, { id });
    const node = data.node;
    return node
      ? {
          id: node.id,
          fileStatus: node.fileStatus,
          errors: (node.fileErrors ?? []).map((e) => `${e.code}: ${e.message}`),
        }
      : null;
  }

  async deleteFiles(fileIds: string[]): Promise<void> {
    const data = await this.shopify.graphql<{
      fileDelete: {
        deletedFileIds: string[] | null;
        userErrors: ShopifyUserError[];
      } | null;
    }>(DELETE_FILES, { fileIds });
    assertNoUserErrors('fileDelete', data.fileDelete);
  }
}
