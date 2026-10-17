import type {
  DocumentKind,
  DocumentLanguage,
  DocumentTemplateRow,
  DocumentTemplateTranslationRow,
} from './documents.types';

export type TemplateVersion = Pick<
  DocumentTemplateRow,
  'source_key' | 'source_sha256' | 'page_count' | 'pages' | 'fields'
> & { language: DocumentLanguage | null };

interface LanguageSources {
  source_language: DocumentLanguage | null;
  source_key: string | null;
  translations: Pick<
    DocumentTemplateTranslationRow,
    'language' | 'source_key'
  >[];
}

export function templateLanguages(row: LanguageSources): DocumentLanguage[] {
  const languages: DocumentLanguage[] = [];
  if (row.source_language && row.source_key) {
    languages.push(row.source_language);
  }
  for (const translation of row.translations) {
    if (translation.source_key && !languages.includes(translation.language)) {
      languages.push(translation.language);
    }
  }
  return languages;
}

interface SignerSources extends LanguageSources {
  kind: DocumentKind;
  translations: Pick<
    DocumentTemplateTranslationRow,
    'language' | 'source_key' | 'fields'
  >[];
}

function readyForSigners(
  kind: DocumentKind,
  fields: readonly unknown[],
): boolean {
  return kind === 'read' || fields.length > 0;
}

export function signerLanguages(row: SignerSources): DocumentLanguage[] {
  return templateLanguages({
    ...row,
    translations: row.translations.filter((t) =>
      readyForSigners(row.kind, t.fields),
    ),
  });
}

export function signerVersion(
  row: DocumentTemplateRow,
  language: DocumentLanguage,
): TemplateVersion | null {
  const version = uploadedVersion(row, language);
  return version && readyForSigners(row.kind, version.fields) ? version : null;
}

export function mainVersion(row: DocumentTemplateRow): TemplateVersion {
  return {
    language: row.source_language,
    source_key: row.source_key,
    source_sha256: row.source_sha256,
    page_count: row.page_count,
    pages: row.pages,
    fields: row.fields,
  };
}

export function findTranslation(
  row: DocumentTemplateRow,
  language: DocumentLanguage,
): DocumentTemplateTranslationRow | null {
  return row.translations.find((t) => t.language === language) ?? null;
}

export function uploadedVersion(
  row: DocumentTemplateRow,
  language: DocumentLanguage,
): TemplateVersion | null {
  if (language === row.source_language) {
    return row.source_key ? mainVersion(row) : null;
  }
  const translation = findTranslation(row, language);
  if (!translation?.source_key) {
    return null;
  }
  return {
    language,
    source_key: translation.source_key,
    source_sha256: translation.source_sha256,
    page_count: translation.page_count,
    pages: translation.pages,
    fields: translation.fields,
  };
}
