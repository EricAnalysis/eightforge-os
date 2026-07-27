import type {
  TableChainArtifact,
  TableSegmentArtifact,
} from '@/lib/extraction/domain/types';
import type { VerifiedFieldHandle } from '@/lib/extraction/domain/verifiedField';

/**
 * Dependency-inversion seam: application orchestration may supply an
 * Interpretation implementation without creating an Extraction ->
 * Interpretation import.
 */
export interface Step3InterpretationBridgeInput {
  readonly extraction_snapshot_id: string;
  readonly chains: readonly TableChainArtifact[];
  readonly segments: readonly TableSegmentArtifact[];
  readonly verified_field_handles: readonly VerifiedFieldHandle[];
  readonly published_at: string;
}

export interface Step3InterpretationBridgePayload {
  readonly interpretation_snapshot: Readonly<Record<string, unknown>> | null;
  readonly semantic_column_mappings: readonly Readonly<Record<string, unknown>>[];
  readonly interpretation_records: readonly Readonly<Record<string, unknown>>[];
}

export type Step3InterpretationBridge = (
  input: Step3InterpretationBridgeInput,
) => Promise<Step3InterpretationBridgePayload>;
