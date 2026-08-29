/** Provider-free real-source Phase B report composer for pricing proposal V2. */
import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION } from
  '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import { implementationIdentity, prepareForgewingPricingProposalV2,
  type ForgewingPricingProposalV2Preparation } from
  '@/scripts/evaluation/prepareForgewingPricingProposalV2';
import type { ForgewingPricingCorpusEntry } from '@/scripts/evaluation/runForgewingPricingCorpus';

export const FORGEWING_PRICING_PROPOSAL_V2_PHASE_B_REPORT_VERSION =
  'forgewing-pricing-proposal-v2-phase-b-v1' as const;

export type ForgewingPricingProposalV2PhaseBReport = Readonly<{
  reportVersion: typeof FORGEWING_PRICING_PROPOSAL_V2_PHASE_B_REPORT_VERSION;
  authority: 'non_authoritative_preparation';
  providerCalls: 0;
  promotionEvidence: false;
  promotionAuthorized: false;
  implementation: ReturnType<typeof implementationIdentity>;
  proposalVersion: typeof FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION;
  sources: readonly Readonly<{
    preparation: ForgewingPricingProposalV2Preparation;
    deterministicReplay: true;
    replayDigestSha256: string;
    v1CandidateDigestStable: true;
  }>[];
  combinedSourceFieldCount: number;
  combinedDuplicateSourceFieldIds: readonly string[];
  limitations: readonly string[];
  reportDigestSha256: string;
}>;

export async function runForgewingPricingProposalV2PhaseB(
  entries: readonly ForgewingPricingCorpusEntry[],
): Promise<ForgewingPricingProposalV2PhaseBReport> {
  if (entries.length === 0) throw new Error('forgewing_v2_phase_b_requires_sources');
  const sources: Array<ForgewingPricingProposalV2PhaseBReport['sources'][number]> = [];
  for (const entry of entries) {
    const first = await prepareForgewingPricingProposalV2(entry);
    const second = await prepareForgewingPricingProposalV2(entry);
    if (canonicalJson(first) !== canonicalJson(second)) {
      throw new Error('forgewing_v2_phase_b_non_deterministic_replay');
    }
    if (first.v1Compatibility.candidateDigestSha256
      !== second.v1Compatibility.candidateDigestSha256) {
      throw new Error('forgewing_v2_phase_b_v1_candidate_drift');
    }
    sources.push({ preparation: first, deterministicReplay: true,
      replayDigestSha256: hashCanonical(second), v1CandidateDigestStable: true });
  }
  const fieldIds = sources.flatMap((source) => source.preparation.fields.sourceFieldIds);
  const duplicateIds = [...new Set(fieldIds.filter((id, index) => fieldIds.indexOf(id) !== index))]
    .sort((a, b) => a.localeCompare(b, 'en-US'));
  if (duplicateIds.length > 0) throw new Error('forgewing_v2_phase_b_source_field_id_collision');
  const base = { reportVersion: FORGEWING_PRICING_PROPOSAL_V2_PHASE_B_REPORT_VERSION,
    authority: 'non_authoritative_preparation' as const, providerCalls: 0 as const,
    promotionEvidence: false as const, promotionAuthorized: false as const,
    implementation: implementationIdentity(),
    proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
    sources, combinedSourceFieldCount: fieldIds.length,
    combinedDuplicateSourceFieldIds: duplicateIds,
    limitations: ['provider_free_structure_only', 'semantic_correctness_not_evaluated',
      'diagnostic_records_inventory_only_no_row_linkage',
      'phase_b_prime_human_field_labels_not_created'] };
  return { ...base, reportDigestSha256: hashCanonical(base) };
}
