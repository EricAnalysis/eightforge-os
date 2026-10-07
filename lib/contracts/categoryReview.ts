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

/** A published priced row as the machine read it, keyed by its evidence anchor. */
export type MachinePricedRow = Readonly<{
  rowId: string;
  description: string | null;
  unit: string | null;
  rate: number | null;
  /** True when the rate is withheld for review: it is a candidate, never a value to copy. */
  rateWithheld: boolean;
  /** The allowed pricing category the shared taxonomy resolves for the row, or null. */
  allowedCategory: string | null;
}>;

export type PricedRowCategoryEvidence = Readonly<{
  categoryReviewTargets: readonly CategoryReviewTarget[];
  /** Every published, source-bound priced row by anchor: the draft's starting point, never a decision. */
  machineRowsByAnchor: ReadonlyMap<string, MachinePricedRow>;
}>;

export function categoryReviewTargets(
  extractionData: unknown,
  sourceDocumentId: string | null = null,
): CategoryReviewTarget[] {
  return [...pricedRowCategoryEvidence(extractionData, sourceDocumentId).categoryReviewTargets];
}

/**
 * One pass over the document's published priced rows: the rows whose category
 * stays unresolved (category review targets), and every row's machine values
 * keyed by the shared priced-line anchor, so a review of the same row can start
 * from what extraction read, category included.
 */
export function pricedRowCategoryEvidence(
  extractionData: unknown,
  sourceDocumentId: string | null = null,
): PricedRowCategoryEvidence {
  const empty: PricedRowCategoryEvidence = { categoryReviewTargets: [], machineRowsByAnchor: new Map() };
  const pdf = asRecord(asRecord(asRecord(asRecord(extractionData)?.extraction)?.content_layers_v1)?.pdf);
  const reconstruction = asRecord(pdf?.priced_schedule_reconstruction_v1) as PagePricedScheduleReconstruction | null;
  if (!reconstruction || !isSupportedPricedScheduleVersion(reconstruction.parser_version)
    || !Array.isArray(reconstruction.pages)) return empty;

  // The document's published priced rows, by the production row builder.
  const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: reconstruction,
    pricedScheduleLayoutObservations: pdf?.layout_observations_v1 })
    .filter((row) => row.source_kind === 'page_priced_schedule');
  if (rows.length === 0) return empty;

  // Pricing over exactly these rows, with the category fallback contract
  // intelligence supplies: whether pricing would give each row a category.
  const coverage = pricedRowCategoryCoverage(rows, { documentId: sourceDocumentId ?? 'category-review', sourceVersionIdentity: null },
    (row) => resolveRateScheduleRowCategory(row).allowedCategory);

  const byRowId = new Map<string, { row: (typeof rows)[number]; allowedCategory: string | null;
    unresolved: { reason: CategoryReviewReason; taxonomyKey: string | null; inPricing: boolean } | null }>();
  rows.forEach((row, sourceIndex) => {
    if (!row.rate_raw?.trim()) return;
    const { resolution, allowedCategory } = resolveRateScheduleRowCategory(row);
    const unresolved = allowedCategory || coverage[sourceIndex]!.categorized ? null : {
      reason: resolution.canonical_category ? 'category_outside_allowed_set' as const : 'no_category_evidence' as const,
      taxonomyKey: resolution.canonical_category,
      inPricing: coverage[sourceIndex]!.visible,
    };
    byRowId.set(row.row_id, { row, allowedCategory, unresolved });
  });
  if (byRowId.size === 0) return empty;

  // Bind each to its source row's exact observations, as every priced-line case does.
  const entries: { page: number; line: unknown; rowId: string }[] = [];
  for (const structuralPage of reconstruction.pages) {
    const page = pricingAuthoritativePage(structuralPage as PricedSchedulePage, reconstruction.parser_version);
    if (!page || page.semantic_status === 'unresolved') continue;
    for (const sourceRow of page.rows) {
      const rowId = `page_priced_schedule:p${page.physical_page_number}:r${sourceRow.row_index}`;
      if (!byRowId.has(rowId)) continue;
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
  const categoryTargets: CategoryReviewTarget[] = [];
  const machineRowsByAnchor = new Map<string, MachinePricedRow>();
  for (const target of targets) {
    const rowId = rowIdByAnchor.get(target.anchorKey);
    if (!rowId || seen.has(target.anchorKey)) continue;
    seen.add(target.anchorKey);
    const { row, allowedCategory, unresolved } = byRowId.get(rowId)!;
    const rateWithheld = rateWithheldByAuthority(row.rate_authority);
    machineRowsByAnchor.set(target.anchorKey, { rowId, description: row.description, unit: row.unit,
      rate: row.rate, rateWithheld, allowedCategory });
    if (!unresolved) continue;
    categoryTargets.push({
      ...target,
      rowId,
      reason: unresolved.reason,
      resolvedTaxonomyKey: unresolved.reason === 'category_outside_allowed_set' ? unresolved.taxonomyKey : null,
      current: { description: row.description, unit: row.unit, rate: row.rate, rateRaw: row.rate_raw },
      rateWithheld,
      pricingState: unresolved.inPricing ? 'in_pricing_without_category' as const : 'excluded_from_pricing' as const,
    });
  }
  return { categoryReviewTargets: categoryTargets, machineRowsByAnchor };
}
