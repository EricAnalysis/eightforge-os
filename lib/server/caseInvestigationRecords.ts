import type { SupabaseClient } from '@supabase/supabase-js';

import type { ProviderCaseInvestigation } from '@/lib/server/caseInvestigationRunner';

/**
 * Durable Case Investigation records (P3c): evidence / proposal history only.
 *
 * One immutable row per accepted investigation, bound to the budget slot it
 * spent. Recording never changes the investigation, and no truth, Validator or
 * precedence path reads these rows; they are shown to the operator beside the
 * case's deterministic investigation, labelled as Forgewing, never as a
 * decision.
 */

export const CASE_INVESTIGATIONS_TABLE = 'forgewing_case_investigations';
export const RECORD_CASE_INVESTIGATION_RPC = 'record_forgewing_case_investigation';

export type CaseInvestigationRecordRow = Readonly<{
  id: string;
  case_id: string;
  case_kind: 'validator_finding';
  rule_id: string | null;
  model: string;
  prompt_version: string;
  diagnosis: string;
  ranked_action_kinds: readonly string[];
  rationale: string;
  evidence_refs: unknown;
  authority: 'non_authoritative';
  requested_by: string;
  created_at: string;
}>;

export type RecordCaseInvestigationResult =
  | Readonly<{ status: 'recorded'; recordId: string; inserted: boolean }>
  | Readonly<{ status: 'not_recorded'; reason: string }>;

/** Best effort: a failure is reported, never thrown, and never alters the investigation. */
export async function recordCaseInvestigation(admin: Pick<SupabaseClient, 'rpc'>, params: Readonly<{
  organizationId: string; projectId: string; caseId: string; requestedBy: string;
  investigation: ProviderCaseInvestigation;
}>): Promise<RecordCaseInvestigationResult> {
  const { investigation } = params;
  try {
    const { data, error } = await admin.rpc(RECORD_CASE_INVESTIGATION_RPC, {
      p_organization_id: params.organizationId,
      p_project_id: params.projectId,
      p_case_id: params.caseId,
      p_case_kind: investigation.caseKind,
      p_finding_check_key: investigation.findingCheckKey,
      p_rule_id: investigation.ruleId,
      p_context_transmitted_digest: investigation.contextTransmittedDigest,
      p_request_digest_sha256: investigation.requestDigestSha256,
      p_reservation_id: investigation.reservationId,
      p_model: investigation.providerModel,
      p_prompt_version: investigation.promptVersion,
      p_diagnosis: investigation.diagnosis,
      p_ranked_action_kinds: [...investigation.rankedActionKinds],
      p_rationale: investigation.rationale,
      p_evidence_refs: investigation.evidenceRefs,
      p_requested_by: params.requestedBy,
    });
    if (error) return { status: 'not_recorded', reason: error.code ?? 'rpc_error' };
    const row = Array.isArray(data) ? data[0] as { investigation_id?: unknown; inserted?: unknown } | undefined : undefined;
    return typeof row?.investigation_id === 'string'
      ? { status: 'recorded', recordId: row.investigation_id, inserted: row.inserted === true }
      : { status: 'not_recorded', reason: 'no_row' };
  } catch {
    return { status: 'not_recorded', reason: 'threw' };
  }
}

/** A case's investigation history, newest first, scoped to the organization's project. */
export async function listCaseInvestigations(admin: Pick<SupabaseClient, 'from'>, params: Readonly<{
  organizationId: string; projectId: string; caseId: string;
}>): Promise<readonly CaseInvestigationRecordRow[]> {
  const { data, error } = await admin.from(CASE_INVESTIGATIONS_TABLE)
    .select('id, case_id, case_kind, rule_id, model, prompt_version, diagnosis, ranked_action_kinds, rationale, '
      + 'evidence_refs, authority, requested_by, created_at')
    .eq('organization_id', params.organizationId).eq('project_id', params.projectId).eq('case_id', params.caseId)
    .order('created_at', { ascending: false }).limit(20);
  if (error) throw new Error(`Failed to read case investigations: ${error.message}`);
  return (data ?? []) as unknown as CaseInvestigationRecordRow[];
}
