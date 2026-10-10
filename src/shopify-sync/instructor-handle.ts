const MAX_HANDLE_LENGTH = 60;

export function baseHandle(
  instructorId: string,
  displayNameEn: string,
): string {
  const slug = displayNameEn
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_HANDLE_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug === '' ? `instructor-${instructorId.slice(0, 8)}` : slug;
}

export function handleCandidate(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base}-${attempt}`;
}
