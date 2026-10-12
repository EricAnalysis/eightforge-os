import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeValidationFinding } from '@/lib/validator/findingSemantics';
import type { ValidationFinding } from '@/types/validator';

// Display semantics (problem, impact, etc.) are derived, not database columns.
const FINDING_COLUMNS = 'id, run_id, project_id, rule_id, check_key, category, severity, status, subject_type, subject_id, field, expected, actual, variance, variance_unit, blocked_reason, decision_eligible, action_eligible, linked_decision_id, linked_action_id, resolved_by_user_id, resolved_at, created_at, updated_at';

/** Uses the caller's authenticated client and the existing project RLS. */
export async function loadOpenProjectFindings(
  client: SupabaseClient,
  projectId: string,
): Promise<ValidationFinding[]> {
  const { data, error } = await client
    .from('project_validation_findings')
    .select(FINDING_COLUMNS)
    .eq('project_id', projectId)
    .eq('status', 'open');

  if (error) {
    throw new Error(`Failed to load project validation findings: ${error.message}`);
  }

  return ((data ?? []) as ValidationFinding[]).map(normalizeValidationFinding);
}
