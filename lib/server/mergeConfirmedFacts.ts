import type { DocumentFactReviewRow } from '@/lib/documentFactReviews';
import type { PipelineFact } from '@/lib/pipeline/types';

/**
 * Returns a new fact_map where PipelineFacts with
 * derivation_status 'calculated' are upgraded to
 * 'success' when an operator has confirmed or
 * corrected the corresponding fact.
 *
 * Pure function. Does not mutate inputs.
 * Does not write to the database.
 * Applied at analysis time only — raw extraction
 * facts remain unchanged in persistent storage.
 *
 * Canonical truth precedence:
 *   operator confirmation > raw extraction derivation
 */
export function mergeConfirmedFacts(
  factMap: Record<string, PipelineFact>,
  reviews: DocumentFactReviewRow[],
): Record<string, PipelineFact> {
  const confirmedKeys = new Set(
    reviews
      .filter(r =>
        r.review_status === 'confirmed' ||
        r.review_status === 'corrected'
      )
      .map(r => r.field_key)
  );

  if (confirmedKeys.size === 0) return factMap;

  const merged: Record<string, PipelineFact> = {
    ...factMap,
  };

  for (const key of confirmedKeys) {
    const fact = merged[key];
    if (
      fact !== undefined &&
      fact.derivation_status === 'calculated'
    ) {
      merged[key] = {
        ...fact,
        derivation_status: 'success',
      };
    }
  }

  return merged;
}
