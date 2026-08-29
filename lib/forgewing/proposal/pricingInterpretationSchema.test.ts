import { describe, expect, it } from 'vitest';

import type { CanonicalContractPricingRow } from '@/lib/canonical/contract/pricing';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { VerifiedField } from '@/lib/extraction/domain/verifiedField';
import type { createCanonicalFact } from '@/lib/interpretation/canonical/canonicalFact';
import {
  ForgewingPricingInterpretationProposalBundleSchema,
  type ForgewingPricingInterpretationProposal,
} from './schema';
import { FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION } from './schemaVersion';

const bundle = {
  schemaVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION,
  authority: 'non_authoritative',
  run: { runId: 'run-1', organizationId: 'org-1', extractionSnapshotId: 'snapshot-1',
    inputSnapshotHash: 'a'.repeat(64) },
  taskId: 'task-1', taskType: 'pricing_interpretation', abstentions: [],
  proposals: [{
    proposalId: 'proposal-1', taskId: 'task-1', taskType: 'pricing_interpretation',
    sourceDocumentId: 'doc-1', sourceArtifactId: 'artifact-1', extractionSnapshotId: 'snapshot-1',
    rowObservationId: 'row-1', physicalPageNumber: 2, artifactLocalIndex: null,
    pricingScopeKind: 'authoritative', pricingEligibility: 'canonical_eligible',
    pricingEligibilityReason: 'authoritative_scope_match',
    pricingScopeIdentity: 'c'.repeat(64),
    inputObservationIds: ['row-1', 'cell-1'], state: 'observed', rowInterpretationState: 'observed',
    confidence: 0.8,
    interpretations: [{ sourceCellId: 'cell-1', semanticRole: 'rate_like_amount', sourceText: '$12.50',
      interpretationState: 'observed', confidence: 0.8, evidenceArtifactIds: ['cell-1'],
      rationaleCodes: ['explicit_currency_marker'] }],
    evidence: [{ artifactId: 'cell-1', sourceDocumentId: 'doc-1', sourceArtifactId: 'artifact-1',
      rawSpan: 'Rate $12.50 / CY' }],
  }],
};

describe('Forgewing pricing interpretation proposal schema', () => {
  it('accepts a source-closed non-authoritative proposal without synthetic page fields', () => {
    expect(ForgewingPricingInterpretationProposalBundleSchema.parse(bundle).authority)
      .toBe('non_authoritative');
  });

  it('rejects unsupported source text, mixed identity, and canonical-looking fields', () => {
    const proposal = bundle.proposals[0];
    expect(() => ForgewingPricingInterpretationProposalBundleSchema.parse({
      ...bundle, proposals: [{ ...proposal,
        interpretations: [{ ...proposal.interpretations[0], sourceText: '$125.00' }] }],
    })).toThrow();
    expect(() => ForgewingPricingInterpretationProposalBundleSchema.parse({
      ...bundle, proposals: [{ ...proposal,
        evidence: [{ ...proposal.evidence[0], sourceArtifactId: 'foreign' }] }],
    })).toThrow();
    expect(() => ForgewingPricingInterpretationProposalBundleSchema.parse({
      ...bundle, proposals: [{ ...proposal, rate: 12.5 }],
    })).toThrow();
  });

  it('is not assignable to assembly, canonical row, verified field, or fact-factory input types', () => {
    if (false) {
      const proposal = null as unknown as ForgewingPricingInterpretationProposal;
      // @ts-expect-error proposal shape is deliberately not an assembly row
      const assemblyRow: ContractPricingAssemblyRow = proposal;
      // @ts-expect-error proposal shape is deliberately not a canonical pricing row
      const canonicalRow: CanonicalContractPricingRow = proposal;
      // @ts-expect-error proposal cannot bypass the runtime verified-field constructor
      const verifiedField: VerifiedField = proposal;
      // @ts-expect-error proposal cannot enter the canonical fact factory
      const factInput: Parameters<typeof createCanonicalFact>[0] = proposal;
      void [assemblyRow, canonicalRow, verifiedField, factInput];
    }
    expect(true).toBe(true);
  });
});
