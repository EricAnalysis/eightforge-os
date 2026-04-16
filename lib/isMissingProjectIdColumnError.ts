/**
 * Detects PostgREST / Postgres errors when `project_id` was referenced but the
 * column is not present (migration not applied yet).
 */
export function isMissingProjectIdColumnError(
  error: { message?: string; code?: string } | null | undefined,
): boolean {
  if (!error?.message) return false;
  const msg = error.message.toLowerCase();
  if (!msg.includes('project_id')) return false;
  return (
    msg.includes('does not exist') ||
    msg.includes('unknown column') ||
    (msg.includes('column') && msg.includes('not exist'))
  );
}
