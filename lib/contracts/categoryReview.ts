import { pricedRowCategoryCoverage } from '@/lib/contracts/contractPricingAssembly';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { rateWithheldByAuthority } from '@/lib/contracts/rateAuthority';
import { resolveRateScheduleRowCategory } from '@/lib/contracts/rateScheduleRowCategory';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { pricingAuthoritativePage } from '@/lib/extraction/pdf/pricedScheduleAuthority';
import type { PagePricedScheduleReconstruction, PricedSchedulePage } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { isSupportedPricedScheduleVersion } from '@/lib/extraction/pdf/pricedScheduleVersion';
import {
  pricedLineTargets,
  type RegionAssertionEntryTarget,
} from '@/lib/humanFactAssertions/regionBoundAssertions';

/**
 * Category review (Forgewing generalization): a priced row whose category
 * deterministic extraction correctly refused to guess must stay in front of a
 * person, not disappear from pricing in silence.
 *
 * The decision is pricing's own. A row qualifies only when BOTH deterministic
 * classifiers that pricing uses come up empty for it: the shared rate taxonomy
 * (`resolveRateScheduleRowCategory`, as contract intelligence applies it) and
 * pricing assembly's own classification of that exact source row. Nothing here
 * guesses a category, reads neighbouring rows' categories, or changes a row.
 *
 * Scope: published page-priced-schedule rows, the rows bound to source
 * observations. Their anchor is the shared priced-line scheme, so a reviewed
 * row confirming the category supersedes the machine row under B3.1.
 */

export type CategoryReviewReason =
  /** Neither the source nor its descriptors name any category. */
  | 'no_category_evidence'
  /** The descriptors name a taxonomy category that is not an allowed pricing category. */
  | 'category_outside_allowed_set';

export type CategoryReviewTarget = RegionAssertionEntryTarget & Readonly<{
  rowId: string;
  reason: CategoryReviewReason;
  /** The taxonomy key the resolver reached, when it reached one outside the allowed set. */
  resolvedTaxonomyKey: string | null;
  /** The row as extraction read it; the reviewer's starting point, never a decision. */
  current: Readonly<{ description: string | null; unit: string | null; rate: number | null; rateRaw: string | null }>;
  /** True when the row's rate is itself withheld for review: its value case already covers this decision. */
  rateWithheld: boolean;
  /** Whether pricing currently drops the row, or keeps it without a category. */
  pricingState: 'excluded_from_pricing' | 'in_pricing_without_category';
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function categoryReviewTargets(
  extractionData: unknown,
  sourceDocumentId: string | null = null,
): CategoryReviewTarget[] {
  const pdf = asRecord(asRecord(asRecord(asRecord(extractionData)?.extraction)?.content_layers_v1)?.pdf);
  const reconstruction = asRecord(pdf?.priced_schedule_reconstruction_v1) as PagePricedScheduleReconstruction | null;
  if (!reconstruction || !isSupportedPricedScheduleVersion(reconstruction.parser_version)
    || !Array.isArray(reconstruction.pages)) return [];

  // The document's published priced rows, by the production row builder.
  const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: reconstruction,
    pricedScheduleLayoutObservations: pdf?.layout_observations_v1 })
    .filter((row) => row.source_kind === 'page_priced_schedule');
  if (rows.length === 0) return [];

  // Pricing over exactly these rows, with the category fallback contract
  // intelligence supplies: whether pricing would give each row a category.
  const coverage = pricedRowCategoryCoverage(rows, { documentId: sourceDocumentId ?? 'category-review', sourceVersionIdentity: null },
    (row) => resolveRateScheduleRowCategory(row).allowedCategory);

  const unresolved = new Map<string, { row: (typeof rows)[number]; reason: CategoryReviewReason;
    taxonomyKey: string | null; inPricing: boolean }>();
  rows.forEach((row, sourceIndex) => {
    if (!row.rate_raw?.trim()) return;
    const { resolution, allowedCategory } = resolveRateScheduleRowCategory(row);
    if (allowedCategory || coverage[sourceIndex]!.categorized) return;
    unresolved.set(row.row_id, {
      row,
      reason: resolution.canonical_category ? 'category_outside_allowed_set' : 'no_category_evidence',
      taxonomyKey: resolution.canonical_category,
      inPricing: coverage[sourceIndex]!.visible,
    });
  });
  if (unresolved.size === 0) return [];

  // Bind each to its source row's exact observations, as every priced-line case does.
  const entries: { page: number; line: unknown; rowId: string }[] = [];
  for (const structuralPage of reconstruction.pages) {
    const page = pricingAuthoritativePage(structuralPage as PricedSchedulePage, reconstruction.parser_version);
    if (!page || page.semantic_status === 'unresolved') continue;
    for (const sourceRow of page.rows) {
      const rowId = `page_priced_schedule:p${page.physical_page_number}:r${sourceRow.row_index}`;
      if (!unresolved.has(rowId)) continue;
      entries.push({ page: page.physical_page_number, rowId,
        line: { raw_text: sourceRow.raw_text, source_refs: sourceRow.cells.flatMap((cell) => cell.source_refs) } });
    }
  }
  const targets = pricedLineTargets(extractionData, sourceDocumentId,
    entries.map((entry) => ({ page: entry.page, reason: 'category_unresolved', line: entry.line })));
  // Pair each target to its row by the anchor the shared scheme gives the row's observations.
  const rowIdByAnchor = new Map<string, string>(entries.flatMap((entry) => {
    const refs = ((asRecord(entry.line)?.source_refs as unknown[]) ?? []).map(asRecord);
    const ids = refs.flatMap((ref) => typeof ref?.observation_id === 'string' ? [ref.observation_id] : []);
    return ids.length > 0 && ids.length === refs.length
      ? [[`p${entry.page}:priced_line:${hashCanonical(ids).slice(0, 32)}`, entry.rowId] as const] : [];
  }));
  const seen = new Set<string>();
  return targets.flatMap((target) => {
    const rowId = rowIdByAnchor.get(target.anchorKey);
    if (!rowId || seen.has(target.anchorKey)) return [];
    seen.add(target.anchorKey);
    const { row, reason, taxonomyKey, inPricing } = unresolved.get(rowId)!;
    return [{
      ...target,
      rowId,
      reason,
      resolvedTaxonomyKey: reason === 'category_outside_allowed_set' ? taxonomyKey : null,
      current: { description: row.description, unit: row.unit, rate: row.rate, rateRaw: row.rate_raw },
      rateWithheld: rateWithheldByAuthority(row.rate_authority),
      pricingState: inPricing ? 'in_pricing_without_category' as const : 'excluded_from_pricing' as const,
    }];
  });
}
