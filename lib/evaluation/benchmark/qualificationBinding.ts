import type { BenchmarkPageLabels } from '@/lib/evaluation/benchmark/benchmarkContract';
import { TASK_BY_INVENTORY_CLASS, type QualificationTask } from '@/lib/evaluation/benchmark/qualificationSet';
import { bindingFailure, type QualificationFailure } from '@/lib/evaluation/benchmark/qualificationTaxonomy';
import {
  valueReadingBenchmarkTargets,
  type ValueReadingBenchmarkPage,
  type ValueReadingBenchmarkTarget,
  type ValueReadingEvidenceClass,
} from '@/lib/evaluation/benchmark/valueReadingBenchmark';
import type { InventoryEntry, ResolutionEvidenceInventory } from '@/lib/evaluation/resolutionEvidenceInventory';
import type { CanonicalBox } from '@/lib/extraction/geometry/canonicalPageFrame';

/**
 * B4.6.1 target binding. Pure. Binds each queue case the inventory found to
 * tracked source truth by geometry alone, so a qualification run scores what
 * production would actually ask, against what the source actually says:
 *
 * - the crop is the case's own reading region (what production would send);
 * - the truth is the labelled row whose rate cell that region contains;
 * - a case is scored only when exactly one labelled priced row's rate cell lies
 *   in its region. Anything else is a binding failure, classified before any
 *   provider call, never a guess.
 *
 * Forgewing output never enters here: truth comes only from the tracked labels.
 * A case with no objective source answer (category review: it exists because
 * no category evidence was found) is human-only, never benchmarked.
 */

/**
 * v2: a production crop is scored only on what it shows (the row's category is truth only when
 * its cell is visible in the crop; a category from outside the crop is an invention). Fixed
 * before any B4.6.1 provider run.
 */
export const QUALIFICATION_BINDING_VERSION = 'b461-target-binding-v2' as const;

/** A labelled page and the pinned document it belongs to. The caller verifies the label frame against the source. */
export type LabelledQualificationPage = Readonly<{
  page: ValueReadingBenchmarkPage;
  documentId: string;
  physicalPageNumber: number;
  labels: BenchmarkPageLabels;
}>;

export type QualificationBindingStatus =
  /** Exactly one labelled priced row: scored against it. */
  | 'bound'
  /** The task has no objective source answer: a person decides; never benchmarked. */
  | 'human_only'
  /** No tracked labels for the page: needs labels before it can be measured. */
  | 'unlabelled_page'
  /** Bound to no single labelled row: a binding failure, classified by the taxonomy. */
  | 'binding_failed';

export type QualificationTargetBinding = Readonly<{
  identity: string;
  task: QualificationTask;
  documentLabel: string;
  physicalPageNumber: number | null;
  /** The labelled page's evidence class; null on an unlabelled page. */
  evidenceClass: ValueReadingEvidenceClass | null;
  pageKey: string | null;
  status: QualificationBindingStatus;
  /** Why the case is human-only, or what failed to bind. */
  reason: string | null;
  failure: QualificationFailure | null;
  labelRowKey: string | null;
  /** For a bound case: truth from the labelled row, crop from the case's own region. */
  target: ValueReadingBenchmarkTarget | null;
}>;

export type QualificationBindingResult = Readonly<{
  version: typeof QUALIFICATION_BINDING_VERSION;
  bindings: readonly QualificationTargetBinding[];
  /** Identities scored against tracked truth: the qualification set's labelled identities. */
  labelledIdentities: ReadonlySet<string>;
}>;

type Rect = Readonly<{ x_min: number; x_max: number; y_min: number; y_max: number }>;

function bounds(boxes: readonly Rect[]): Rect {
  return { x_min: Math.min(...boxes.map((box) => box.x_min)), x_max: Math.max(...boxes.map((box) => box.x_max)),
    y_min: Math.min(...boxes.map((box) => box.y_min)), y_max: Math.max(...boxes.map((box) => box.y_max)) };
}

function centreInside(box: Rect, region: Rect): boolean {
  const x = (box.x_min + box.x_max) / 2;
  const y = (box.y_min + box.y_max) / 2;
  return x >= region.x_min && x <= region.x_max && y >= region.y_min && y <= region.y_max;
}

type LabelledRow = Readonly<{ rowKey: string; rateBox: Rect; cellBoxes: readonly Rect[] }>;

/** The page's labelled priced rows (the B4.6 target rule), with each row's rate cell. */
function labelledPricedRows(page: LabelledQualificationPage): readonly LabelledRow[] {
  const { targets } = valueReadingBenchmarkTargets(page.labels, page.page);
  const cells = new Map((page.labels.cells.items ?? []).map((cell) => [cell.labelId, cell]));
  const rows = new Map((page.labels.rows.items ?? []).map((row) => [row.rowKey, row]));
  return targets.map((target) => {
    const rowCells = rows.get(target.rowKey)!.orderedCellLabelIds.map((id) => cells.get(id)!);
    const rate = rowCells.find((cell) => cell.columnName === page.page.columns.rate)!;
    return { rowKey: target.rowKey, rateBox: rate.box, cellBoxes: rowCells.map((cell) => cell.box) };
  });
}

/** Category review exists because no source evidence names an allowed category: there is nothing objective to score. */
export const HUMAN_ONLY_TASKS: Readonly<Partial<Record<QualificationTask, string>>> = Object.freeze({
  choose_category: 'semantic: the case exists because no source evidence names an allowed category',
});

export function bindQualificationTargets(params: Readonly<{
  inventories: readonly ResolutionEvidenceInventory[];
  labelledPages: readonly LabelledQualificationPage[];
}>): QualificationBindingResult {
  const pageOf = new Map(params.labelledPages.map((page) => [`${page.documentId}:${page.physicalPageNumber}`, page]));
  const rowsOf = new Map(params.labelledPages.map((page) => [page.page.pageKey, labelledPricedRows(page)]));

  // Distinct identities, first occurrence wins (the same evidence in two inventories is one case).
  const entries = new Map<string, InventoryEntry>();
  for (const entry of params.inventories.flatMap((inventory) => inventory.entries)) {
    if (TASK_BY_INVENTORY_CLASS[entry.inventoryClass] && !entries.has(entry.identity)) entries.set(entry.identity, entry);
  }

  type Draft = { entry: InventoryEntry; task: QualificationTask; page: LabelledQualificationPage | null;
    status: QualificationBindingStatus; reason: string | null; failure: QualificationFailure | null; rowKey: string | null };
  const drafts: Draft[] = [...entries.values()].sort((a, b) => a.identity.localeCompare(b.identity)).map((entry) => {
    const task = TASK_BY_INVENTORY_CLASS[entry.inventoryClass]!;
    const page = entry.physicalPageNumber === null ? null : pageOf.get(`${entry.documentId}:${entry.physicalPageNumber}`) ?? null;
    const draft: Draft = { entry, task, page, status: 'binding_failed', reason: null, failure: null, rowKey: null };
    const humanOnly = HUMAN_ONLY_TASKS[task];
    if (humanOnly) return { ...draft, status: 'human_only', reason: humanOnly };
    if (!page) return { ...draft, status: 'unlabelled_page', reason: 'no tracked labels for this page' };
    if (!entry.readingRegion) {
      return { ...draft, reason: 'reading region unproven', failure: bindingFailure('reading_region_unproven') };
    }
    const region = bounds(entry.readingRegion.canonicalBoxes);
    const rows = rowsOf.get(page.page.pageKey)!;
    const withRate = rows.filter((row) => centreInside(row.rateBox, region));
    if (withRate.length === 1) return { ...draft, status: 'bound', rowKey: withRate[0]!.rowKey };
    if (withRate.length > 1) {
      return { ...draft, reason: `region holds ${withRate.length} labelled rate cells`,
        failure: bindingFailure('region_spans_rows', String(withRate.length)) };
    }
    // No rate cell: a truncated region on a priced row, or a line that is not a priced row at all.
    const touchesRow = rows.some((row) => row.cellBoxes.some((box) => centreInside(box, region)));
    return touchesRow
      ? { ...draft, reason: 'region holds a labelled priced row but not its rate cell', failure: bindingFailure('region_misses_rate') }
      : { ...draft, reason: 'region holds no labelled priced row', failure: bindingFailure('region_not_priced_row') };
  });

  // One physical row, one case: two cases on the same labelled row both fail, loudly, never double counted.
  const boundCount = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.status === 'bound') boundCount.set(`${draft.page!.page.pageKey}/${draft.rowKey}`, (boundCount.get(`${draft.page!.page.pageKey}/${draft.rowKey}`) ?? 0) + 1);
  }
  for (const draft of drafts) {
    if (draft.status !== 'bound') continue;
    const count = boundCount.get(`${draft.page!.page.pageKey}/${draft.rowKey}`)!;
    if (count > 1) {
      draft.status = 'binding_failed';
      draft.reason = `${count} cases bind the same labelled row`;
      draft.failure = bindingFailure('duplicate_case_for_row', String(count));
    }
  }

  // Scoring targets: the labelled row's truth, cropped as production would crop the case.
  const cropByPageRow = new Map<string, readonly CanonicalBox[]>();
  for (const draft of drafts) {
    if (draft.status === 'bound') cropByPageRow.set(`${draft.page!.page.pageKey}/${draft.rowKey}`, draft.entry.readingRegion!.canonicalBoxes);
  }
  const targetsByPage = new Map(params.labelledPages.map((page) => [page.page.pageKey, new Map(
    valueReadingBenchmarkTargets(page.labels, page.page, {
      cropBoxes: (rowKey) => cropByPageRow.get(`${page.page.pageKey}/${rowKey}`),
    }).targets.map((target) => [target.rowKey, target]))]));

  const bindings = drafts.map((draft): QualificationTargetBinding => ({
    identity: draft.entry.identity,
    task: draft.task,
    documentLabel: draft.entry.documentLabel,
    physicalPageNumber: draft.entry.physicalPageNumber,
    evidenceClass: draft.page?.page.evidenceClass ?? null,
    pageKey: draft.page?.page.pageKey ?? null,
    status: draft.status,
    reason: draft.reason,
    failure: draft.failure,
    labelRowKey: draft.rowKey,
    target: draft.status === 'bound' ? targetsByPage.get(draft.page!.page.pageKey)!.get(draft.rowKey!)! : null,
  }));
  return {
    version: QUALIFICATION_BINDING_VERSION,
    bindings,
    labelledIdentities: new Set(bindings.filter((binding) => binding.status === 'bound').map((binding) => binding.identity)),
  };
}
