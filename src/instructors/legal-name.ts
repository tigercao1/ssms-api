export interface LegalNameSource {
  first_name: string | null;
  last_name: string | null;
  display_name_en: string;
}

export function legalNameOf(row: LegalNameSource): string {
  const first = row.first_name?.trim();
  const last = row.last_name?.trim();
  return first && last ? `${first} ${last}` : row.display_name_en;
}
