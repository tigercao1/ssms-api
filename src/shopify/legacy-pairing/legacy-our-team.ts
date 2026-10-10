export const LEGACY_METAOBJECT_TYPE = 'our_team';
export const LEGACY_TRANSLATION_LOCALE = 'en';
const PAGE_SIZE = 50;

export type GraphqlFn = <T>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

export interface LegacyField {
  key: string;
  type: string;
  value: string | null;
  jsonValue: unknown;
  reference: unknown;
}

export interface LegacyTranslation {
  key: string;
  value: string | null;
  locale: string;
  outdated: boolean;
  updatedAt: string | null;
}

export interface LegacyEntry {
  id: string;
  handle: string;
  type: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
  publishableStatus: string | null;
  fields: LegacyField[];
  translatableContent: { key: string; value: string | null; locale: string }[];
  translations: LegacyTranslation[];
}

export interface LegacySnapshot {
  metaobjectType: string;
  translationLocale: string;
  fetchedAt: string;
  count: number;
  entries: LegacyEntry[];
}

export const LIST_LEGACY_ENTRIES = `
  query LegacyOurTeam($type: String!, $first: Int!, $after: String) {
    metaobjects(type: $type, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        type
        displayName
        createdAt
        updatedAt
        capabilities { publishable { status } }
        fields {
          key
          type
          value
          jsonValue
          reference {
            __typename
            ... on MediaImage { id alt image { url width height } }
            ... on GenericFile { id url }
            ... on Metaobject { id handle type }
          }
        }
      }
    }
  }
`;

export const LIST_LEGACY_TRANSLATIONS = `
  query LegacyOurTeamTranslations($ids: [ID!]!, $first: Int!, $locale: String!) {
    translatableResourcesByIds(resourceIds: $ids, first: $first) {
      nodes {
        resourceId
        translatableContent { key value locale }
        translations(locale: $locale) { key value locale outdated updatedAt }
      }
    }
  }
`;

interface MetaobjectNode {
  id: string;
  handle: string;
  type: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
  capabilities?: { publishable?: { status: string } | null } | null;
  fields: LegacyField[];
}

interface MetaobjectPage {
  metaobjects: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: MetaobjectNode[];
  };
}

interface TranslationPage {
  translatableResourcesByIds: {
    nodes: {
      resourceId: string;
      translatableContent: LegacyEntry['translatableContent'];
      translations: LegacyTranslation[];
    }[];
  };
}

export async function fetchLegacySnapshot(
  graphql: GraphqlFn,
  now: () => Date = () => new Date(),
): Promise<LegacySnapshot> {
  const nodes: MetaobjectNode[] = [];
  let after: string | null = null;
  for (;;) {
    const page: MetaobjectPage = await graphql<MetaobjectPage>(
      LIST_LEGACY_ENTRIES,
      { type: LEGACY_METAOBJECT_TYPE, first: PAGE_SIZE, after },
    );
    nodes.push(...page.metaobjects.nodes);
    if (!page.metaobjects.pageInfo.hasNextPage) {
      break;
    }
    after = page.metaobjects.pageInfo.endCursor;
  }

  const translations = new Map<
    string,
    TranslationPage['translatableResourcesByIds']['nodes'][number]
  >();
  for (let i = 0; i < nodes.length; i += PAGE_SIZE) {
    const ids = nodes.slice(i, i + PAGE_SIZE).map((n) => n.id);
    const page = await graphql<TranslationPage>(LIST_LEGACY_TRANSLATIONS, {
      ids,
      first: ids.length,
      locale: LEGACY_TRANSLATION_LOCALE,
    });
    for (const resource of page.translatableResourcesByIds.nodes) {
      translations.set(resource.resourceId, resource);
    }
  }

  const entries = nodes.map((node) => ({
    id: node.id,
    handle: node.handle,
    type: node.type,
    displayName: node.displayName,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    publishableStatus: node.capabilities?.publishable?.status ?? null,
    fields: node.fields,
    translatableContent: translations.get(node.id)?.translatableContent ?? [],
    translations: translations.get(node.id)?.translations ?? [],
  }));

  return {
    metaobjectType: LEGACY_METAOBJECT_TYPE,
    translationLocale: LEGACY_TRANSLATION_LOCALE,
    fetchedAt: now().toISOString(),
    count: entries.length,
    entries,
  };
}

export function legacyEntryName(entry: LegacyEntry): string {
  const field = entry.fields.find((f) => f.key === 'name');
  return (field?.value ?? entry.displayName ?? '').trim();
}
