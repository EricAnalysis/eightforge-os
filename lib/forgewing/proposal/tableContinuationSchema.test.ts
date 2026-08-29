import { describe, expect, it } from 'vitest';

import {
  ForgewingProposalBundleSchema,
  ForgewingTableContinuationProposalBundleSchema,
  ForgewingTableContinuationProposalSchema,
} from '@/lib/forgewing/proposal/schema';
import { FORGEWING_TABLE_CONTINUATION_PROPOSAL_SCHEMA_VERSION } from '@/lib/forgewing/proposal/schemaVersion';
import {
  assertProposalEvidenceContract,
  hasResolvableProposalEvidence,
} from '@/lib/forgewing/proposal/guards';

const base = {
  proposalId: 'continuation-proposal-1',
  taskId: 'continuation-task-1',
  taskType: 'table_continuation' as const,
  sourceDocumentId: 'document-1',
  sourceArtifactId: 'source-artifact-1',
  extractionSnapshotId: 'snapshot-1',
  priorSegmentId: 'segment-prior',
  nextSegmentId: 'segment-next',
  priorPageArtifactId: 'page-prior',
  nextPageArtifactId: 'page-next',
  priorPhysicalPageNumber: 8,
  nextPhysicalPageNumber: 9,
  priorArtifactLocalIndex: 7,
  nextArtifactLocalIndex: 8,
  priorSourceLayer: 'table_artifact' as const,
  nextSourceLayer: 'table_artifact' as const,
  inputObservationIds: ['segment-prior', 'segment-next'],
  confidence: 0.8,
  rationaleCode: 'column_structure_consistent' as const,
};

const evidence = (side: 'prior' | 'next') => ({
  artifactId: side === 'prior' ? 'segment-prior' : 'segment-next',
  sourceDocumentId: 'document-1',
  sourceArtifactId: 'source-artifact-1',
  pageArtifactId: side === 'prior' ? 'page-prior' : 'page-next',
  physicalPageNumber: side === 'prior' ? 8 : 9,
  artifactLocalIndex: side === 'prior' ? 7 : 8,
  sourceLayer: 'table_artifact' as const,
});

const proposal = {
  ...base,
  state: 'inferred' as const,
  relation: 'same_table' as const,
  evidence: [evidence('prior'), evidence('next')],
};

const bundle = {
  schemaVersion: FORGEWING_TABLE_CONTINUATION_PROPOSAL_SCHEMA_VERSION,
  authority: 'non_authoritative' as const,
  run: {
    runId: 'forgewing-run-table-continuation-1',
    organizationId: 'organization-1',
    extractionSnapshotId: 'snapshot-1',
    inputSnapshotHash: 'a'.repeat(64),
  },
  taskId: 'continuation-task-1',
  taskType: 'table_continuation' as const,
  proposals: [proposal],
  abstentions: [],
};

describe('Forgewing table-continuation proposal contract', () => {
  it('preserves child-cell layer-local provenance instead of equating it to the segment', () => {
    expect(ForgewingTableContinuationProposalSchema.safeParse({
      ...proposal,
      inputObservationIds: ['segment-prior', 'segment-next', 'prior-cell', 'next-cell'],
      evidence: [
        { ...evidence('prior'), artifactId: 'prior-cell', artifactLocalIndex: 10_001, sourceLayer: 'ocr' },
        { ...evidence('next'), artifactId: 'next-cell', artifactLocalIndex: 20_001, sourceLayer: 'pdf_native_text' },
      ],
    }).success).toBe(true);
  });

  it('accepts an adjacent two-page proposal under its task-specific v1 version', () => {
    const parsed = ForgewingTableContinuationProposalSchema.parse(proposal);
    expect(hasResolvableProposalEvidence(parsed)).toBe(true);
    expect(() => assertProposalEvidenceContract(parsed)).not.toThrow();
    expect(ForgewingTableContinuationProposalBundleSchema.safeParse(bundle).success).toBe(true);
    expect(ForgewingProposalBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('keeps relation consistent with semantic state', () => {
    expect(ForgewingTableContinuationProposalSchema.safeParse({
      ...proposal,
      state: 'ambiguous',
      relation: 'same_table',
      rationaleCode: 'mixed_evidence',
    }).success).toBe(false);
    const { relation: _relation, ...withoutRelation } = proposal;
    void _relation;
    expect(ForgewingTableContinuationProposalSchema.safeParse({
      ...withoutRelation,
      state: 'insufficient_evidence',
      evidence: [],
      confidence: null,
      rationaleCode: 'insufficient_structure',
      missingEvidence: [{ code: 'insufficient_table_context' }],
    }).success).toBe(true);
  });

  it('requires distinct physically adjacent segments and pages', () => {
    expect(ForgewingTableContinuationProposalSchema.safeParse({
      ...proposal,
      nextSegmentId: 'segment-prior',
    }).success).toBe(false);
    expect(ForgewingTableContinuationProposalSchema.safeParse({
      ...proposal,
      nextPhysicalPageNumber: 10,
    }).success).toBe(false);
  });

  it('requires both candidate segments in the input closure and both pages in evidence', () => {
    expect(ForgewingTableContinuationProposalSchema.safeParse({
      ...proposal,
      inputObservationIds: ['segment-prior', 'cell-prior'],
    }).success).toBe(false);
    expect(ForgewingTableContinuationProposalSchema.safeParse({
      ...proposal,
      evidence: [evidence('prior'), { ...evidence('prior'), artifactId: 'segment-next' }],
    }).success).toBe(false);
  });

  it('rejects foreign source identity and invented page provenance', () => {
    expect(ForgewingTableContinuationProposalSchema.safeParse({
      ...proposal,
      evidence: [
        { ...evidence('prior'), sourceArtifactId: 'foreign-artifact' },
        evidence('next'),
      ],
    }).success).toBe(false);
    expect(ForgewingTableContinuationProposalSchema.safeParse({
      ...proposal,
      evidence: [evidence('prior'), { ...evidence('next'), physicalPageNumber: 99 }],
    }).success).toBe(false);
  });

  it('rejects the region schema version for a continuation bundle', () => {
    expect(ForgewingProposalBundleSchema.safeParse({
      ...bundle,
      schemaVersion: 'forgewing-proposal-v1',
    }).success).toBe(false);
  });

  it('accepts schema_changed as a bounded rationale code', () => {
    expect(ForgewingTableContinuationProposalSchema.safeParse({
      ...proposal,
      relation: 'separate_tables',
      rationaleCode: 'schema_changed',
    }).success).toBe(true);
  });
});
