export interface SignupNames {
  firstName: string | null;
  lastName: string | null;
  displayNameEn: string | null;
}

const MAX_NAME_LENGTH = 100;

function capped(value: string): string | null {
  const result = Array.from(value.trim())
    .slice(0, MAX_NAME_LENGTH)
    .join('')
    .trim();
  return result === '' ? null : result;
}

function cleanName(value: unknown): string | null {
  return typeof value === 'string' ? capped(value) : null;
}

export function signupNamesFromMetadata(
  metadata: Record<string, unknown> | undefined,
): SignupNames {
  const firstName = cleanName(metadata?.first_name);
  const lastName = cleanName(metadata?.last_name);
  const nickname = cleanName(metadata?.nickname);
  return {
    firstName,
    lastName,
    displayNameEn: nickname ?? capped(`${firstName ?? ''} ${lastName ?? ''}`),
  };
}
