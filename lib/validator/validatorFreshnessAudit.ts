import { auditProjectFreshnessShadow } from '@/lib/interpretation/persistence/freshnessAudit';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export async function reportValidatorFreshnessShadow(projectId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.warn('[validatorFreshnessAudit] skipped', {
      mode: 'shadow',
      projectId,
      reason: 'server_not_configured',
      blocking: false,
    });
    return;
  }

  const results = await auditProjectFreshnessShadow(admin, projectId);
  for (const result of results) {
    if (result.fresh) continue;
    console.warn('[validatorFreshnessAudit] stale input observed', {
      mode: 'shadow',
      blocking: false,
      projectId,
      sourceDocumentId: result.sourceDocumentId,
      codes: result.codes,
      expected: result.expected,
      actual: result.actual,
    });
  }
}
