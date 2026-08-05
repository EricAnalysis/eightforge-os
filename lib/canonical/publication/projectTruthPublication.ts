import type { CanonicalShadowComparison, CanonicalShadowComparisonBoundary } from '@/lib/canonical/parity/shadowComparison';
import type { CanonicalProjectTruth } from '@/lib/canonical/project/projectTruth';

export const CANONICAL_PROJECT_TRUTH_SCHEMA_VERSION = 'canonical-project-truth-v1' as const;
export const PROJECT_TRUTH_PUBLICATION_SCHEMA_VERSION = 'project-truth-shadow-publication-v1' as const;

export type SourceArtifactSnapshotEntry = {
  readonly documentId: string;
  readonly documentType: string | null;
  readonly documentRole: string | null;
  readonly storagePath: string | null;
  readonly sourceArtifactId: string | null;
  readonly sourceSha256: string | null;
  readonly storageObjectVersion: string | null;
  readonly mediaTypeSniffed: string | null;
  readonly byteLength: number | null;
  readonly artifactCreatedAt: string | null;
  readonly exactSourceIdentity: string | null;
};

export type ProjectTruthPublicationSourceDocument = SourceArtifactSnapshotEntry & {
  readonly family: string | null;
  readonly isGoverning: boolean;
};

export type ProjectTruthPublicationGapReason =
  | 'missing_field'
  | 'unresolved_mapping'
  | 'rejected_input'
  | 'lost_evidence'
  | 'unsupported_state'
  | 'current_truth_conflict'
  | 'source_unavailable'
  | 'pack_not_executed'
  | 'pack_failed'
  | 'publication_error';

export type ProjectTruthPublicationGap = {
  readonly gapKey: string;
  readonly boundary: CanonicalShadowComparisonBoundary | 'manifest' | 'publication';
  readonly reason: ProjectTruthPublicationGapReason;
  readonly sourceIdentity: string;
  readonly rejectingFunction: string | null;
  readonly missingFields?: readonly string[];
  readonly detail: string;
  readonly rawValues: Readonly<Record<string, unknown>>;
  readonly sourceCoordinates: Readonly<Record<string, unknown>>;
  readonly evidenceSurvivesElsewhere: boolean;
  readonly canonicalRecoveryPossible: boolean;
  readonly silent: false;
};

export type CanonicalProjectTruthCore = Omit<CanonicalProjectTruth, 'transactions'> & {
  readonly transactions: {
    readonly count: number;
    readonly digest: string;
    readonly part: 'registry.transactions.ndjson.gz';
  };
};

export type ProjectTruthParityReport = {
  readonly comparisons: readonly CanonicalShadowComparison[];
  readonly amountDeltas: Readonly<Record<string, { readonly current: number | null; readonly canonical: number | null; readonly delta: number | null }>>;
  readonly quantityDeltas: Readonly<Record<string, { readonly current: number | null; readonly canonical: number | null; readonly delta: number | null }>>;
};

export type ProjectTruthPublicationManifest = {
  readonly publicationId: string;
  readonly projectId: string;
  readonly organizationId: string;
  readonly sourceRun: {
    readonly runId: string;
    readonly runAt: string;
    readonly completedAt: string | null;
    readonly triggeredBy: string;
    readonly triggeredByUserId: string | null;
    readonly ruleVersion: string | null;
    readonly inputsSnapshotHash: string;
    readonly rulesApplied: readonly string[];
  };
  readonly sourceDocuments: readonly ProjectTruthPublicationSourceDocument[];
  readonly pipelineVersion: string | null;
  readonly canonicalSchemaVersion: typeof CANONICAL_PROJECT_TRUTH_SCHEMA_VERSION;
  readonly publicationSchemaVersion: typeof PROJECT_TRUTH_PUBLICATION_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly inputCounts: Readonly<Record<string, number>>;
  readonly outputCounts: Readonly<Record<string, number>>;
  readonly status: 'complete' | 'partial' | 'failed';
  readonly gapSummary: {
    readonly counts: Readonly<Record<string, number>>;
    readonly silentLossCount: 0;
  };
  readonly parity: readonly Pick<CanonicalShadowComparison, 'boundary' | 'classification'>[];
  readonly sectionDigests: Readonly<Record<string, string>>;
  readonly supersedes: string | null;
  readonly nonAuthoritative: true;
  readonly mode: 'shadow_only';
  readonly persisted: false;
};
