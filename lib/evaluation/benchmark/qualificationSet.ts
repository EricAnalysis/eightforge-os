import { hashCanonical } from '@/lib/extraction/domain/hash';
import { VALUE_READING_ACTIVATION_BAR } from '@/lib/evaluation/benchmark/valueReadingBenchmark';
import type {
  InventoryClass,
  InventoryEntry,
  ResolutionEvidenceInventory,
} from '@/lib/evaluation/resolutionEvidenceInventory';

/**
 * B4.6.1 qualification-set proposal. Pure: from one or more offline resolution
 * evidence inventories (lib/evaluation/resolutionEvidenceInventory.ts) to a
 * typed, deterministic proposal of what a qualification run would measure.
 *
 * It creates no labels, calls no provider and scores nothing. Qualification
 * classes are typed by the task Forgewing would be asked to do, and are never
 * pooled: each class meets the pre-registered bar (VALUE_READING_ACTIVATION_BAR)
 * on its own. It adds no threshold of its own.
 */

export const QUALIFICATION_SET_VERSION = 'b461-qualification-set-v1' as const;

/** The task a class asks of Forgewing. Different tasks are different qualifications. */
export type QualificationTask =
  | 'confirm_scanned_amount'
  | 'read_unreadable_amount'
  | 'read_withheld_line'
  | 'read_unresolved_line'
  | 'choose_category';

/** Inventory classes that are investigations, not readings: out of scope for value-reading qualification. */
export const OUT_OF_SCOPE_INVENTORY_CLASSES: readonly InventoryClass[] = Object.freeze([
  'structure_case', 'coverage_gap', 'pricing_withheld_page',
]);

export const TASK_BY_INVENTORY_CLASS: Readonly<Partial<Record<InventoryClass, QualificationTask>>> = Object.freeze({
  scanned_review_required_value: 'confirm_scanned_amount',
  unreadable_native_amount: 'read_unreadable_amount',
  withheld_bundle: 'read_withheld_line',
  legacy_unresolved_line: 'read_unresolved_line',
  category_review: 'choose_category',
});

export const QUALIFICATION_TASKS: readonly QualificationTask[] = Object.freeze([
  'confirm_scanned_amount', 'read_unreadable_amount', 'read_withheld_line', 'read_unresolved_line', 'choose_category',
]);

export type QualificationClassStatus =
  /** Enough distinct targets, every one with tracked truth: ready to run. */
  | 'ready'
  /** Enough distinct targets, some without tracked truth: labels must be approved first. */
  | 'needs_labels'
  /** Fewer targets than the bar's minimum: cannot qualify, reported, never padded. */
  | 'insufficient_targets';

export type QualificationClassProposal = Readonly<{
  task: QualificationTask;
  status: QualificationClassStatus;
  targets: number;
  labelled: number;
  unlabelled: number;
  /** Value targets whose same decision also needs a category: scored for both fields. */
  alsoCategory: number;
  documents: Readonly<Record<string, number>>;
  /** Sorted identities: the exact set a run measures. */
  identities: readonly string[];
  /** Digest of the identities, so a run binds to this exact set. */
  setDigest: string;
}>;

export type QualificationSetProposal = Readonly<{
  version: typeof QUALIFICATION_SET_VERSION;
  minTargetsPerClass: number;
  inventories: readonly Readonly<{ schema: string; documents: readonly string[] }>[];
  classes: readonly QualificationClassProposal[];
  /** Identities in two classes: withheld from every class until resolved, never double counted. */
  excludedOverlaps: readonly Readonly<{ identity: string; classes: readonly InventoryClass[] }>[];
  outOfScope: Readonly<Record<string, number>>;
  /** Digest over every class's set digest: the proposal a decision cites. */
  proposalDigest: string;
}>;

export function proposeQualificationSet(params: Readonly<{
  inventories: readonly ResolutionEvidenceInventory[];
  /** Identities with tracked, human-approved truth. Never created here. */
  labelledIdentities?: ReadonlySet<string>;
}>): QualificationSetProposal {
  const labelled = params.labelledIdentities ?? new Set<string>();
  const minTargets = VALUE_READING_ACTIVATION_BAR.minRowsPerClass;

  const entries: InventoryEntry[] = params.inventories.flatMap((inventory) => [...inventory.entries]);
  const classesByIdentity = new Map<string, Set<InventoryClass>>();
  for (const entry of entries) {
    classesByIdentity.set(entry.identity, (classesByIdentity.get(entry.identity) ?? new Set()).add(entry.inventoryClass));
  }
  const overlapping = new Set([...classesByIdentity].filter(([, classes]) => classes.size > 1).map(([identity]) => identity));

  const outOfScope: Record<string, number> = {};
  const byTask = new Map<QualificationTask, Map<string, InventoryEntry>>();
  for (const entry of entries) {
    if (overlapping.has(entry.identity)) continue;
    const task = TASK_BY_INVENTORY_CLASS[entry.inventoryClass];
    if (!task) {
      outOfScope[entry.inventoryClass] = (outOfScope[entry.inventoryClass] ?? 0) + 1;
      continue;
    }
    // Distinct identities only: the same evidence in two inventories is one target.
    const bucket = byTask.get(task) ?? new Map<string, InventoryEntry>();
    if (!bucket.has(entry.identity)) bucket.set(entry.identity, entry);
    byTask.set(task, bucket);
  }

  const classes = QUALIFICATION_TASKS.map((task): QualificationClassProposal => {
    const bucket = [...(byTask.get(task)?.values() ?? [])];
    const identities = bucket.map((entry) => entry.identity).sort();
    const labelledCount = identities.filter((identity) => labelled.has(identity)).length;
    const documents: Record<string, number> = {};
    for (const entry of bucket) documents[entry.documentLabel] = (documents[entry.documentLabel] ?? 0) + 1;
    const status: QualificationClassStatus = identities.length < minTargets
      ? 'insufficient_targets'
      : labelledCount === identities.length ? 'ready' : 'needs_labels';
    return {
      task,
      status,
      targets: identities.length,
      labelled: labelledCount,
      unlabelled: identities.length - labelledCount,
      alsoCategory: bucket.filter((entry) => task !== 'choose_category' && entry.alsoUnresolved.includes('category')).length,
      documents: Object.fromEntries(Object.entries(documents).sort(([a], [b]) => a.localeCompare(b))),
      identities,
      setDigest: hashCanonical({ version: QUALIFICATION_SET_VERSION, task, identities }),
    };
  });

  return {
    version: QUALIFICATION_SET_VERSION,
    minTargetsPerClass: minTargets,
    inventories: params.inventories.map((inventory) => ({
      schema: inventory.schema,
      documents: inventory.documents.map((document) => document.label),
    })),
    classes,
    excludedOverlaps: [...overlapping].sort().map((identity) => ({
      identity, classes: [...classesByIdentity.get(identity)!].sort(),
    })),
    outOfScope: Object.fromEntries(Object.entries(outOfScope).sort(([a], [b]) => a.localeCompare(b))),
    proposalDigest: hashCanonical({ version: QUALIFICATION_SET_VERSION, classes: classes.map((entry) => [entry.task, entry.setDigest]) }),
  };
}
