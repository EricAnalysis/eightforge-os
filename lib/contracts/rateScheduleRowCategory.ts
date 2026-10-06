import type { ContractRateScheduleRow } from '@/lib/contracts/types';
import { allowedCategoryForCanonicalTaxonomyKey, resolveCanonicalRateCategory } from '@/lib/validator/rateTaxonomy';

/**
 * A rate-schedule row's category, as contract intelligence decides it: the
 * shared rate taxonomy over the row's own source category and descriptors,
 * narrowed to the allowed pricing categories. One home, shared by contract
 * intelligence and the category-review selector, so both decide identically.
 */
export function resolveRateScheduleRowCategory(row: ContractRateScheduleRow): {
  resolution: ReturnType<typeof resolveCanonicalRateCategory>;
  allowedCategory: string | null;
} {
  const resolution = resolveCanonicalRateCategory({
    sourceCategory: row.category ?? row.source_category ?? row.material_type,
    sourceDescriptors: [
      row.description,
      row.rate_raw,
      row.raw_text,
      ...(row.raw_cells ?? []),
    ],
    existingCanonicalCategory: row.canonical_category,
    existingConfidence: row.category_confidence,
  });
  return {
    resolution,
    allowedCategory: allowedCategoryForCanonicalTaxonomyKey(resolution.canonical_category),
  };
}
