/** Safe, persisted representation of a source-identity store read failure. */
export type SourceIdentityReadFailure = {
  readonly code:
    | 'relation_unavailable'
    | 'permission_denied'
    | 'query_failed'
    | 'schema_unavailable'
    | 'unknown';
  readonly safeMessage: string;
};

type SourceIdentityReadErrorLike = {
  readonly code?: string | null;
  readonly message?: string | null;
};

/**
 * Classifies a provider error without retaining credentials, SQL, paths,
 * database details, hints, or stack traces in canonical/persisted state.
 */
export function sanitizeSourceIdentityReadFailure(
  error: SourceIdentityReadErrorLike | null | undefined,
): SourceIdentityReadFailure {
  const providerCode = error?.code?.trim().toUpperCase() ?? '';
  const message = error?.message?.toLowerCase() ?? '';

  if (
    providerCode === '42P01'
    || providerCode === 'PGRST205'
    || /relation\b.*\bdoes not exist/.test(message)
  ) {
    return Object.freeze({
      code: 'relation_unavailable',
      safeMessage: 'Source identity store relation is unavailable.',
    });
  }
  if (providerCode === '42501' || /permission denied|not authorized|unauthorized/.test(message)) {
    return Object.freeze({
      code: 'permission_denied',
      safeMessage: 'Source identity store access was denied.',
    });
  }
  if (
    providerCode === '42703'
    || providerCode === 'PGRST204'
    || providerCode === 'PGRST106'
    || /schema cache|schema\b.*\bunavailable|column\b.*\bdoes not exist/.test(message)
  ) {
    return Object.freeze({
      code: 'schema_unavailable',
      safeMessage: 'Source identity store schema is unavailable.',
    });
  }
  if (providerCode.length > 0 || message.length > 0) {
    return Object.freeze({
      code: 'query_failed',
      safeMessage: 'Source identity store query failed.',
    });
  }
  return Object.freeze({
    code: 'unknown',
    safeMessage: 'Source identity store read failed.',
  });
}
