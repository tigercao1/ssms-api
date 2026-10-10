import { Injectable } from '@nestjs/common';
import { ShopifyAdminClient } from '../shopify/shopify-admin.client';
import { assertNoUserErrors } from '../shopify/shopify-user-errors';
import type { ShopifyUserError } from '../shopify/shopify.errors';
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
}
