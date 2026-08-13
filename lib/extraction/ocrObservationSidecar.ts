import type { OcrGeometryWord } from '@/lib/extraction/pdf/ocrGeometryLayout';
import type { GenericContentAnalysis } from '@/lib/extraction/domain/genericContentScheduling';
import type { ParserIdentity } from '@/lib/extraction/domain/types';
import type { PageSourceLayer } from '@/lib/extraction/provenance/physicalPageCoordinate';

export interface ExtractorPhysicalPageSeed {
  readonly physical_page_number: number;
  readonly total_physical_pages: number;
  readonly source_layer: Exclude<PageSourceLayer, 'legacy' | 'table_artifact'>;
  readonly artifact_local_index: number;
}

export type ExtractorPhysicalPageProvenance =
  | { readonly state: 'iterated'; readonly seed: ExtractorPhysicalPageSeed }
  | { readonly state: 'conflicting' };

export interface GenericContentDiagnosticGap {
  readonly gap_key: string;
  readonly stage: 'source_ingest' | 'ocr' | 'table_reconstruction' | 'region_arbitration';
  readonly reason:
    | 'decode_failure'
    | 'ocr_region_failure'
    | 'timeout'
    | 'table_structure_unresolved'
    | 'arbitration_unresolved';
  readonly retryable: boolean;
  readonly attempts: number;
  readonly error_category: string;
}

export interface LocatedOcrPageObservation {
  readonly page_number: number;
  readonly render_sha256: string;
  readonly width: number;
  readonly height: number;
  readonly text_detected: boolean;
  readonly words: readonly OcrGeometryWord[];
  /** Unbound extractor proof. Bound to immutable source identity by Step 1. */
  readonly physical_page_provenance?: ExtractorPhysicalPageProvenance;
}

export interface LocatedOcrObservationSidecar {
  readonly pages: readonly LocatedOcrPageObservation[];
  /**
   * Independent engine observations used by the Step 3 shadow only. Keeping
   * them separate prevents merge/deduplication from erasing disagreement.
   */
  readonly engine_pages?: readonly LocatedEnginePageObservation[];
  readonly content_analysis?: GenericContentAnalysis;
  readonly content_gaps?: readonly GenericContentDiagnosticGap[];
}

export interface LocatedEnginePageObservation extends LocatedOcrPageObservation {
  readonly engine: 'native' | 'ocr' | 'vision';
  readonly parser: ParserIdentity;
}

const LOCATED_OCR_OBSERVATIONS = Symbol.for('eightforge.locatedOcrObservations');

type PayloadWithLocatedOcrObservations = {
  readonly [LOCATED_OCR_OBSERVATIONS]?: LocatedOcrObservationSidecar;
};

/**
 * Keeps OCR render identity and word geometry available to the shadow publisher
 * without adding it to the legacy extraction JSON persisted by current writers.
 */
export function attachLocatedOcrObservations<T extends object>(
  payload: T,
  observations: LocatedOcrObservationSidecar,
): T {
  Object.defineProperty(payload, LOCATED_OCR_OBSERVATIONS, {
    value: observations,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return payload;
}

export function getLocatedOcrObservations(
  payload: object,
): LocatedOcrObservationSidecar | null {
  return (payload as PayloadWithLocatedOcrObservations)[LOCATED_OCR_OBSERVATIONS] ?? null;
}
