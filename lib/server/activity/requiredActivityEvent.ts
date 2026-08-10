import type { ActivityEventResult } from './logActivityEvent';

export type RequiredActivityEventResult =
  | { ok: true }
  | { ok: false; status: 500 | 503; error: string };

/**
 * Fail closed when a truth mutation's required activity event is unavailable.
 * The caller supplies the inverse mutation so current state cannot outlive its
 * required append-only audit record.
 */
export async function enforceRequiredActivityEvent(params: {
  activityResult: ActivityEventResult;
  rollback: () => Promise<{ error: { message: string } | null }>;
  auditFailureMessage: string;
  rollbackFailurePrefix: string;
}): Promise<RequiredActivityEventResult> {
  if (params.activityResult.ok) return { ok: true };

  const rollbackResult = await params.rollback();
  if (rollbackResult.error) {
    return {
      ok: false,
      status: 500,
      error: `${params.rollbackFailurePrefix}: ${rollbackResult.error.message}`,
    };
  }
  return { ok: false, status: 503, error: params.auditFailureMessage };
}
