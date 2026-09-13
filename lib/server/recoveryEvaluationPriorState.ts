import {
  RecoveryCandidateV2Schema,
  RecoveryTypeV2Schema,
} from '@/lib/extraction/recovery/recoveryCandidateV2';
import {
  recoveryEvaluationUnitIdentity,
  type RecoveryEvaluationPriorState,
} from '@/lib/extraction/recovery/recoveryEvaluationPlanner';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

type ReadResult = { data: unknown; error: { message?: string } | null };
type ReadQuery = PromiseLike<ReadResult> & {
  select(columns: string): ReadQuery;
  eq(column: string, value: unknown): ReadQuery;
};
export type RecoveryEvaluationReadClient = Readonly<{
  from(table: string): ReadQuery;
}>;

export type RecoveryEvaluationPriorStateResult =
  | Readonly<{ status: 'ok'; state: RecoveryEvaluationPriorState }>
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'read_failed'; reason: string }>;

function records(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : []).filter((entry): entry is Record<string, unknown> =>
    entry != null && typeof entry === 'object' && !Array.isArray(entry));
}

function candidateIds(
  value: unknown,
  recoveryType: string,
  pageRepresentationDigest: string,
): string[] | null {
  if (!Array.isArray(value)) return null;
  const candidates = value.flatMap((entry) => {
    const parsed = RecoveryCandidateV2Schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const ids = candidates.map((candidate) => candidate.candidateId);
  return candidates.length === value.length && ids.length > 0
    && candidates.every((candidate) => candidate.recoveryType === recoveryType
      && candidate.pageRepresentationDigest === pageRepresentationDigest)
    && new Set(ids).size === ids.length ? ids : null;
}

export async function loadRecoveryEvaluationPriorState(
  query: Readonly<{
    organizationId: string;
    sourceDocumentId: string;
    sourceArtifactId: string;
  }>,
  dependencies: Readonly<{ admin?: RecoveryEvaluationReadClient | null }> = {},
): Promise<RecoveryEvaluationPriorStateResult> {
  const admin = dependencies.admin === undefined
    ? getSupabaseAdmin() as unknown as RecoveryEvaluationReadClient | null
    : dependencies.admin;
  if (!admin) return { status: 'not_configured' };

  const scopedRead = (table: string, columns: string) => admin.from(table).select(columns)
    .eq('organization_id', query.organizationId)
    .eq('source_document_id', query.sourceDocumentId)
    .eq('source_artifact_id', query.sourceArtifactId);
  const [proposalRead, outcomeRead] = await Promise.all([
    scopedRead('forgewing_recovery_proposals',
      'recovery_type, page_representation_digest, recovery_candidates'),
    scopedRead('forgewing_recovery_generation_outcomes',
      'recovery_type, page_representation_digest, provider_invoked, candidate_ids'),
  ]);
  if (proposalRead.error || outcomeRead.error) {
    return {
      status: 'read_failed',
      reason: proposalRead.error?.message ?? outcomeRead.error?.message ?? 'prior_state_read_failed',
    };
  }

  const proposedUnitIdentities: string[] = [];
  for (const row of records(proposalRead.data)) {
    if (row.recovery_type === 'pricing_rate_single_observation') continue;
    const recoveryType = RecoveryTypeV2Schema.safeParse(row.recovery_type);
    const pageRepresentationDigest = row.page_representation_digest;
    if (!recoveryType.success || typeof pageRepresentationDigest !== 'string') {
      return { status: 'read_failed', reason: 'invalid_prior_state' };
    }
    const ids = candidateIds(
      row.recovery_candidates,
      recoveryType.data,
      pageRepresentationDigest,
    );
    if (!ids) return { status: 'read_failed', reason: 'invalid_prior_state' };
    proposedUnitIdentities.push(recoveryEvaluationUnitIdentity({
      recoveryType: recoveryType.data,
      pageRepresentationDigest,
      candidateIds: ids,
    }));
  }
  const providerInvokedUnitIdentities: string[] = [];
  for (const row of records(outcomeRead.data)) {
    if (row.recovery_type === 'pricing_rate_single_observation') continue;
    const recoveryType = RecoveryTypeV2Schema.safeParse(row.recovery_type);
    const pageRepresentationDigest = row.page_representation_digest;
    const ids = Array.isArray(row.candidate_ids)
      && row.candidate_ids.every((id) => typeof id === 'string'
        && /^recovery-candidate-v2-[a-f0-9]{64}$/.test(id))
      ? row.candidate_ids as string[] : null;
    if (!recoveryType.success || typeof pageRepresentationDigest !== 'string'
      || typeof row.provider_invoked !== 'boolean' || !ids || ids.length === 0) {
      return { status: 'read_failed', reason: 'invalid_prior_state' };
    }
    if (!row.provider_invoked) continue;
    providerInvokedUnitIdentities.push(recoveryEvaluationUnitIdentity({
      recoveryType: recoveryType.data,
      pageRepresentationDigest,
      candidateIds: ids,
    }));
  }

  return {
    status: 'ok',
    state: Object.freeze({
      proposedUnitIdentities: Object.freeze([...new Set(proposedUnitIdentities)]),
      // An effective confirmation necessarily belongs to a proposal, and exact
      // proposals are already the stronger suppression rule. The pure planner
      // retains this explicit input for independently supplied confirmations.
      confirmedCandidateIds: Object.freeze([]),
      providerInvokedUnitIdentities: Object.freeze([
        ...new Set(providerInvokedUnitIdentities),
      ]),
    }),
  };
}
