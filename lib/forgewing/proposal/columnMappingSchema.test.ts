import { describe, expect, it } from 'vitest';

import {
  ForgewingColumnMappingProposalBundleSchema,
  ForgewingColumnMappingProposalSchema,
  ForgewingProposalBundleSchema,
} from '@/lib/forgewing/proposal/schema';
import { FORGEWING_COLUMN_MAPPING_PROPOSAL_SCHEMA_VERSION } from '@/lib/forgewing/proposal/schemaVersion';
import {
  assertProposalEvidenceContract,
  hasResolvableProposalEvidence,
} from '@/lib/forgewing/proposal/guards';

const candidateColumns = [
  { columnId: 'mapping-0', columnIndex: 0 },
  { columnId: 'mapping-1', columnIndex: 1 },
  { columnId: 'mapping-2', columnIndex: 2 },
];

const evidence = (artifactId: string) => ({
  artifactId,
  sourceDocumentId: 'document-1',
  sourceArtifactId: 'source-artifact-1',
  pageArtifactId: 'page-1',
  physicalPageNumber: 5,
  artifactLocalIndex: artifactId === 'cell-0' ? 10 : 11,
  sourceLayer: 'table_artifact' as const,
});

const mapped = (columnId: string, columnIndex: number, artifactId: string, proposedRole = 'rate') => ({
  columnId,
  columnIndex,
  state: 'inferred' as const,
  proposedRole,
  confidence: 0.7,
  rationaleCodes: ['header_semantics'] as const,
  evidenceArtifactIds: [artifactId],
});

const insufficient = {
  columnId: 'mapping-2',
  columnIndex: 2,
  state: 'insufficient_evidence' as const,
  confidence: null,
  rationaleCodes: ['insufficient_structure'] as const,
  evidenceArtifactIds: [],
  missingEvidence: [{ code: 'missing_column_context' as const }],
};

const base = {
  proposalId: 'forgewing-proposal-column-mapping-1',
  taskId: 'forgewing-task-column-mapping-1',
  taskType: 'column_mapping' as const,
  sourceDocumentId: 'document-1',
  sourceArtifactId: 'source-artifact-1',
  extractionSnapshotId: 'snapshot-1',
  tableSegmentId: 'table-1',
  pageArtifactId: 'page-1',
  physicalPageNumber: 5,
  artifactLocalIndex: 4,
  sourceLayer: 'table_artifact' as const,
  inputObservationIds: ['table-1', 'cell-0', 'cell-1'],
  candidateColumns,
  confidence: 0.7,
};

const partialProposal = {
  ...base,
  state: 'inferred' as const,
  mappingCompleteness: 'partial' as const,
  columnMappings: [
    mapped('mapping-0', 0, 'cell-0', 'description'),
    mapped('mapping-1', 1, 'cell-1', 'rate'),
    insufficient,
  ],
  evidence: [evidence('cell-0'), evidence('cell-1')],
};

const bundle = {
  schemaVersion: FORGEWING_COLUMN_MAPPING_PROPOSAL_SCHEMA_VERSION,
  authority: 'non_authoritative' as const,
  run: {
    runId: 'forgewing-run-column-mapping-1',
    organizationId: 'organization-1',
    extractionSnapshotId: 'snapshot-1',
    inputSnapshotHash: 'b'.repeat(64),
  },
  taskId: 'forgewing-task-column-mapping-1',
  taskType: 'column_mapping' as const,
  proposals: [partialProposal],
  abstentions: [],
};

describe('Forgewing column-mapping proposal contract', () => {
  it('accepts partial mapping while preserving unresolved candidates', () => {
    const parsed = ForgewingColumnMappingProposalSchema.parse(partialProposal);
    expect(parsed.columnMappings).toHaveLength(3);
    expect(parsed.mappingCompleteness).toBe('partial');
    expect(hasResolvableProposalEvidence(parsed)).toBe(true);
    expect(() => assertProposalEvidenceContract(parsed)).not.toThrow();
    expect(ForgewingColumnMappingProposalBundleSchema.safeParse(bundle).success).toBe(true);
    expect(ForgewingProposalBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('closes every mapping over the exact candidate column identity and index', () => {
    expect(ForgewingColumnMappingProposalSchema.safeParse({
      ...partialProposal,
      columnMappings: [mapped('foreign-column', 0, 'cell-0')],
    }).success).toBe(false);
    expect(ForgewingColumnMappingProposalSchema.safeParse({
      ...partialProposal,
      columnMappings: [
        mapped('mapping-0', 0, 'cell-0'),
        mapped('mapping-1', 0, 'cell-1'),
      ],
    }).success).toBe(false);
  });

  it('does not permit the deterministic other fallback as a confident role', () => {
    expect(ForgewingColumnMappingProposalSchema.safeParse({
      ...partialProposal,
      columnMappings: [mapped('mapping-0', 0, 'cell-0', 'other')],
    }).success).toBe(false);
  });

  it('preserves duplicate proposed roles because the deterministic contract has no uniqueness rule', () => {
    expect(ForgewingColumnMappingProposalSchema.safeParse({
      ...base,
      candidateColumns: candidateColumns.slice(0, 2),
      state: 'inferred',
      mappingCompleteness: 'complete',
      columnMappings: [
        mapped('mapping-0', 0, 'cell-0'),
        mapped('mapping-1', 1, 'cell-1'),
      ],
      evidence: [evidence('cell-0'), evidence('cell-1')],
    }).success).toBe(true);
  });

  it('represents ambiguity without choosing a role', () => {
    expect(ForgewingColumnMappingProposalSchema.safeParse({
      ...base,
      state: 'ambiguous',
      mappingCompleteness: 'partial',
      columnMappings: [{
        columnId: 'mapping-1',
        columnIndex: 1,
        state: 'ambiguous',
        candidateRoles: ['rate', 'extension'],
        confidence: null,
        rationaleCodes: ['mixed_evidence'],
        evidenceArtifactIds: ['cell-0', 'cell-1'],
      }],
      evidence: [evidence('cell-0'), evidence('cell-1')],
    }).success).toBe(true);
  });

  it('rejects undeclared, foreign, and missing reconstructed evidence', () => {
    expect(ForgewingColumnMappingProposalSchema.safeParse({
      ...partialProposal,
      evidence: [evidence('cell-0')],
    }).success).toBe(false);
    expect(ForgewingColumnMappingProposalSchema.safeParse({
      ...partialProposal,
      evidence: [
        evidence('cell-0'),
        { ...evidence('cell-1'), sourceArtifactId: 'foreign-artifact' },
      ],
    }).success).toBe(false);
  });

  it('keeps all-insufficient output evidence-free and non-resolved', () => {
    expect(ForgewingColumnMappingProposalSchema.safeParse({
      ...base,
      candidateColumns: [candidateColumns[2]],
      state: 'insufficient_evidence',
      mappingCompleteness: 'partial',
      confidence: null,
      columnMappings: [insufficient],
      evidence: [],
      missingEvidence: [{ code: 'missing_column_context' }],
    }).success).toBe(true);
  });

  it('keeps the task under its distinct schema version', () => {
    expect(ForgewingProposalBundleSchema.safeParse({
      ...bundle,
      schemaVersion: 'forgewing-proposal-v1',
    }).success).toBe(false);
  });
});
