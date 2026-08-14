import type {
  ForgewingAbstentionReason,
  ForgewingBoundingBoxSchema,
  ForgewingEvidenceRef,
  ForgewingProposalBundle,
  ForgewingProposalState,
  ForgewingRegionLabel,
} from '@/lib/forgewing/proposal/schema';
import type { z } from 'zod';

export const FORGEWING_REGION_EVALUATION_VERSION = 'forgewing-region-evaluation-v1' as const;

export type EvaluationBoundingBox = z.infer<typeof ForgewingBoundingBoxSchema>;

export type RegionEvaluationIdentity = Readonly<{
  organizationId: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  extractionSnapshotId: string;
  pageArtifactId: string;
  regionArtifactId: string;
  physicalPageNumber: number | null;
  artifactLocalIndex: number | null;
  sourceLayer: string | null;
}>;

export type FrozenRegionArtifact = Readonly<{
  artifactId: string;
  kind: 'region' | 'cell' | 'fragment';
  organizationId: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  extractionSnapshotId: string;
  pageArtifactId: string;
  page: number;
  boundingBox: EvaluationBoundingBox;
  rawText: string | null;
  physicalPageNumber: number | null;
  artifactLocalIndex: number | null;
  sourceLayer: string | null;
}>;

export type DeterministicRegionClassificationObservation = Readonly<{
  identity: RegionEvaluationIdentity;
  state: 'resolved' | 'ambiguous';
  classification: 'table' | null;
  evidenceIds: readonly string[];
  diagnostics: readonly string[];
}>;

export type DeterministicRegionSnapshot = Readonly<{
  extractionSnapshotId: string;
  observations: readonly DeterministicRegionClassificationObservation[];
}>;

export type ForgewingEvaluationRuntimeMetadata = Readonly<{
  model?: string;
  promptTemplateId?: string;
  promptTemplateVersion?: string;
}>;

export type ForgewingRegionEvaluationInput = Readonly<{
  deterministicSnapshot: DeterministicRegionSnapshot;
  forgewingBundle: ForgewingProposalBundle;
  sourceArtifacts: readonly FrozenRegionArtifact[];
  runtimeMetadata?: ForgewingEvaluationRuntimeMetadata;
}>;

export type RegionComparisonStatus =
  | 'agreement'
  | 'disagreement'
  | 'baseline_ambiguous'
  | 'forgewing_ambiguous'
  | 'both_ambiguous'
  | 'baseline_only'
  | 'forgewing_only'
  | 'not_comparable';

export type EvidenceFidelityStatus = 'valid' | 'invalid' | 'unverifiable';

export type EvidenceCheckStatus = 'match' | 'mismatch' | 'not_claimed' | 'unverifiable';

export type EvidenceFidelityFinding = Readonly<{
  proposalId: string;
  evidenceIndex: number;
  artifactId: string;
  status: EvidenceFidelityStatus;
  checks: Readonly<{
    artifact: EvidenceCheckStatus;
    sourceDocument: EvidenceCheckStatus;
    sourceArtifact: EvidenceCheckStatus;
    extractionSnapshot: EvidenceCheckStatus;
    pageArtifact: EvidenceCheckStatus;
    physicalPage: EvidenceCheckStatus;
    artifactLocalIndex: EvidenceCheckStatus;
    sourceLayer: EvidenceCheckStatus;
    geometry: EvidenceCheckStatus;
    rawSpan: EvidenceCheckStatus;
  }>;
  diagnostics: readonly string[];
}>;

export type ConfidenceBucket =
  | '0.0-0.2'
  | '0.2-0.4'
  | '0.4-0.6'
  | '0.6-0.8'
  | '0.8-1.0'
  | 'null';

export type ConfidenceBucketMetrics = Readonly<{
  total: number;
  agreementCount: number;
  disagreementCount: number;
  notComparableCount: number;
}>;

export type RegionEvaluationMetrics = Readonly<{
  totalComparable: number;
  agreementCount: number;
  disagreementCount: number;
  agreementRate: number | null;
  baselineAmbiguousCount: number;
  forgewingAmbiguousCount: number;
  bothAmbiguousCount: number;
  abstentionCount: number;
  runtimeAbstentionsByReason: Readonly<Record<ForgewingAbstentionReason, number>>;
  semanticInsufficientEvidenceCount: number;
  successfulClassificationCount: number;
  evidenceValidCount: number;
  evidenceInvalidCount: number;
  evidenceUnverifiableCount: number;
  silentHallucinationCount: number;
  byClassification: Readonly<Record<ForgewingRegionLabel, number>>;
  confidenceBuckets: Readonly<Record<ConfidenceBucket, ConfidenceBucketMetrics>>;
}>;

export type RegionEvaluationComparison = Readonly<{
  identity: RegionEvaluationIdentity | null;
  comparisonStatus: RegionComparisonStatus;
  candidateImprovement: boolean;
  deterministic: Readonly<{
    state: DeterministicRegionClassificationObservation['state'] | 'absent';
    classification: 'table' | null;
    evidenceIds: readonly string[];
  }>;
  forgewing: Readonly<{
    proposalId: string | null;
    state: ForgewingProposalState | 'runtime_abstention' | 'absent';
    classification: ForgewingRegionLabel | null;
    confidence: number | null;
    evidence: readonly ForgewingEvidenceRef[];
    rationale?: string;
    abstentionReason?: ForgewingAbstentionReason;
  }>;
  deltas: readonly string[];
  diagnostics: readonly string[];
}>;

export type ForgewingRegionEvaluationReport = Readonly<{
  evaluationVersion: typeof FORGEWING_REGION_EVALUATION_VERSION;
  authority: 'non_authoritative_measurement';
  taskType: 'region_classification';
  runId: string;
  extractionSnapshotId: string;
  metadata: Readonly<{
    model: string | null;
    promptTemplateId: string | null;
    promptTemplateVersion: string | null;
    proposalSchemaVersion: string;
  }>;
  summary: Readonly<{
    comparisonCount: number;
    diagnosticCodes: readonly string[];
  }>;
  comparisons: readonly RegionEvaluationComparison[];
  evidenceFindings: readonly EvidenceFidelityFinding[];
  metrics: RegionEvaluationMetrics;
}>;
