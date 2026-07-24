import type { OcrGeometryWord } from '@/lib/extraction/pdf/ocrGeometryLayout';

export interface LocatedOcrPageObservation {
  readonly page_number: number;
  readonly render_sha256: string;
  readonly width: number;
  readonly height: number;
  readonly text_detected: boolean;
  readonly words: readonly OcrGeometryWord[];
}

export interface LocatedOcrObservationSidecar {
  readonly pages: readonly LocatedOcrPageObservation[];
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
