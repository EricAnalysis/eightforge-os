import { hashCanonical } from '@/lib/extraction/domain/hash';
import { formatReviewedValue, verifyRegionEvidence, type HumanFactAssertionRow } from '@/lib/humanFactAssertions/regionBoundAssertions';
import type { ResolutionAction, ResolutionQueue } from '@/lib/resolution/resolutionCases';
import { deriveValueReadingLifecycle } from '@/lib/resolution/valueReadingLifecycle';
import {
  loadValueReadingRecords, VALUE_READING_OUTCOMES_TABLE, VALUE_READING_RECOVERY_TYPE,
  type ValueReadingClient, type ValueReadingOutcomeCode, type ValueReadingOutcomeReason,
} from '@/lib/server/valueReadingProposals';

const CODES: readonly ValueReadingOutcomeCode[] = ['generated_proposal', 'unreadable', 'existing_result_reused',
  'recovery_disabled', 'activation_not_allowed', 'entitlement_missing', 'data_policy_not_approved', 'budget_exhausted',
  'provider_failed', 'structured_output_invalid', 'deterministic_validation_failed', 'evidence_binding_failed',
  'proposal_persist_failed', 'system_error'];
const REASONS: readonly ValueReadingOutcomeReason[] = ['proposal_recorded', 'request_already_answered', 'kill_switch_off',
  'provider_not_configured', 'activation_disabled', 'no_entitlement', 'entitlement_revoked', 'data_policy_not_approved',
  'data_policy_revoked', 'budget_exhausted', 'budget_not_configured', 'provider_timeout', 'provider_truncated_output',
  'provider_error', 'invalid_json', 'invalid_proposal', 'proposal_value_validation_failed', 'binding_changed',
  'region_image_unavailable', 'write_failed', 'gate_lookup_failed', 'reservation_failed'];

/** The case kinds a value reading investigates: every priced line a person can review a value for. */
const VALUE_READING_CASE_KINDS: ReadonlySet<string> = new Set(['unreadable_priced_line', 'withheld_priced_line', 'review_required_value']);

/** Adds only non-authoritative readings to cases the Core queue already derived. */
export async function addValueReadingsToResolutionQueue(
  admin: ValueReadingClient,
  params: Readonly<{
    organizationId: string;
    queue: ResolutionQueue;
    extractionDataByDocument: ReadonlyMap<string, unknown>;
    assertions: readonly HumanFactAssertionRow[];
  }>,
): Promise<ResolutionQueue> {
  const { queue, organizationId } = params;
  if (!queue.forgewingSuggestionsIncluded) return queue;
  const documentIds = [...new Set(queue.cases.flatMap((entry) =>
    VALUE_READING_CASE_KINDS.has(entry.kind) && entry.documentId ? [entry.documentId] : []))];
  if (documentIds.length === 0) return queue;
  const records = await loadValueReadingRecords(admin, { organizationId, documentIds });
  const outcomesRead = await admin.from(VALUE_READING_OUTCOMES_TABLE)
    .select('id, organization_id, source_document_id, source_artifact_id, physical_page_number, page_representation_digest, '
      + 'anchor_key, recovery_type, outcome_code, sanitized_reason, observed_at')
    .eq('organization_id', organizationId).eq('recovery_type', VALUE_READING_RECOVERY_TYPE).in('source_document_id', documentIds);
  if (outcomesRead.error) throw new Error('Value-reading outcomes unavailable');
  const outcomes = (Array.isArray(outcomesRead.data) ? outcomesRead.data : []) as Record<string, unknown>[];
  const cases = queue.cases.map((entry) => {
    if (!VALUE_READING_CASE_KINDS.has(entry.kind) || !entry.documentId) return entry;
    const enter = entry.actions.find((action) => action.kind === 'enter_reviewed_value');
    if (!enter || enter.kind !== 'enter_reviewed_value') return entry;
    const target = enter.target;
    const evidence = verifyRegionEvidence({ extractionData: params.extractionDataByDocument.get(entry.documentId),
      physicalPageNumber: target.physicalPageNumber, pageRepresentationDigest: target.pageRepresentationDigest,
      sourceObservationIds: target.sourceObservationIds });
    if (evidence.status !== 'verified' || !evidence.sourceArtifactId) return entry;
    const exactProposals = records.proposals.filter((proposal) => {
      const binding = proposal.binding;
      return binding.organizationId === organizationId && binding.projectId === queue.projectId
        && binding.resolutionCaseId === entry.caseId && binding.sourceDocumentId === entry.documentId
        && binding.sourceArtifactId === evidence.sourceArtifactId && binding.physicalPageNumber === target.physicalPageNumber
        && binding.pageRepresentationDigest === target.pageRepresentationDigest && binding.anchorKey === target.anchorKey
        && hashCanonical([...binding.sourceObservationIds].sort()) === hashCanonical([...target.sourceObservationIds].sort())
        && hashCanonical(binding.sourceRegion) === hashCanonical(target.sourceRegion);
    });
    const currentPageDigests = new Map([[entry.documentId, new Map([[target.physicalPageNumber, target.pageRepresentationDigest]])]]);
    const lifecycle = deriveValueReadingLifecycle({ ...records, proposals: exactProposals,
      assertions: params.assertions, currentPageDigests });
    const pending = new Set(lifecycle.filter((state) => state.state === 'pending' && state.offerable).map((state) => state.proposalId));
    // Rejected/deferred history is never bypassed by offering an older proposal.
    const latest = [...exactProposals].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || left.proposalId.localeCompare(right.proposalId, 'en-US')).at(-1);
    const proposal = latest && pending.has(latest.proposalId) && latest.reading.kind === 'value' ? latest : null;
    const latestOutcome = outcomes.filter((row) => row.organization_id === organizationId
      && row.recovery_type === VALUE_READING_RECOVERY_TYPE && row.source_document_id === entry.documentId
      && row.source_artifact_id === evidence.sourceArtifactId && row.physical_page_number === target.physicalPageNumber
      && row.page_representation_digest === target.pageRepresentationDigest && row.anchor_key === target.anchorKey
      && typeof row.id === 'string' && typeof row.observed_at === 'string' && Number.isFinite(Date.parse(row.observed_at))
      && CODES.includes(row.outcome_code as ValueReadingOutcomeCode) && REASONS.includes(row.sanitized_reason as ValueReadingOutcomeReason))
      .sort((left, right) => Date.parse(left.observed_at as string) - Date.parse(right.observed_at as string)
        || (left.id as string).localeCompare(right.id as string, 'en-US')).at(-1);
    const actions: ResolutionAction[] = entry.actions.map((action) =>
      action.kind === 'enter_reviewed_value' && proposal ? { ...action, forgewingProposalId: proposal.proposalId } : action);
    actions.push({ kind: 'request_value_reading', method: 'POST',
      endpoint: `/api/projects/${queue.projectId}/resolution-cases/value-reading` });
    if (proposal) actions.push({ kind: 'review_value_reading', method: 'POST',
      endpoint: `/api/projects/${queue.projectId}/resolution-cases/value-reading-review`,
      proposalId: proposal.proposalId, proposalDigestSha256: proposal.proposalDigestSha256, dispositions: ['rejected', 'deferred'] });
    return { ...entry, actions,
      suggestions: proposal && proposal.reading.kind === 'value' ? [...entry.suggestions, {
        source: 'forgewing_value_reading' as const, proposedValue: formatReviewedValue(proposal.reading.rateRow),
        rateRow: proposal.reading.rateRow, uncalibratedCertainty: null, proposalId: proposal.proposalId,
      }] : entry.suggestions,
      valueReadingOutcome: latestOutcome ? { code: latestOutcome.outcome_code as ValueReadingOutcomeCode,
        reason: latestOutcome.sanitized_reason as ValueReadingOutcomeReason } : null,
    };
  });
  return { ...queue, cases };
}
