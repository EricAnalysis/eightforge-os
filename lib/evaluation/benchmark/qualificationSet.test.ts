import { describe, expect, it } from 'vitest';

import { proposeQualificationSet, QUALIFICATION_TASKS } from '@/lib/evaluation/benchmark/qualificationSet';
import { VALUE_READING_ACTIVATION_BAR } from '@/lib/evaluation/benchmark/valueReadingBenchmark';
import type { InventoryClass, InventoryEntry, ResolutionEvidenceInventory } from '@/lib/evaluation/resolutionEvidenceInventory';

function entry(identity: string, inventoryClass: InventoryClass, documentLabel = 'Golden', alsoUnresolved: string[] = []): InventoryEntry {
  return { identity, inventoryClass, documentLabel, documentId: `doc-${documentLabel}`, physicalPageNumber: 1,
    caseId: `case:${identity}`, caseKind: 'review_required_value', tier: 'missing_authoritative_value',
    rootCauseKey: 'r', diagnosticCode: null, alsoUnresolved, originalSourceText: null, readingRegion: null };
}
function inventory(entries: InventoryEntry[]): ResolutionEvidenceInventory {
  return { schema: 'resolution_evidence_inventory_v1', documents: [{ documentId: 'd', label: 'Golden' }], entries,
    countsByClass: {} as never, countsByDocumentAndClass: {}, attachedCategoryRequirements: 0,
    distinctIdentities: entries.length, overlaps: [], unclassifiedKinds: {} };
}
const scanned = (count: number, prefix = 's', label = 'Golden') =>
  Array.from({ length: count }, (_, index) => entry(`${prefix}${String(index).padStart(3, '0')}`, 'scanned_review_required_value', label));

describe('B4.6.1 qualification set proposal', () => {
  it('types classes by task, never pools them, and holds each to the pre-registered minimum', () => {
    const min = VALUE_READING_ACTIVATION_BAR.minRowsPerClass;
    const proposal = proposeQualificationSet({ inventories: [inventory([
      ...scanned(min),
      ...Array.from({ length: 3 }, (_, index) => entry(`c${index}`, 'category_review')),
      entry('page1', 'coverage_gap'), entry('page2', 'structure_case'),
    ])] });
    expect(proposal.classes.map((entry) => entry.task)).toEqual(QUALIFICATION_TASKS);
    const byTask = Object.fromEntries(proposal.classes.map((entry) => [entry.task, entry]));
    expect(byTask.confirm_scanned_amount).toMatchObject({ targets: min, status: 'needs_labels', unlabelled: min });
    expect(byTask.choose_category).toMatchObject({ targets: 3, status: 'insufficient_targets' });
    expect(byTask.read_withheld_line).toMatchObject({ targets: 0, status: 'insufficient_targets' });
    expect(proposal.outOfScope).toEqual({ coverage_gap: 1, structure_case: 1 });
  });

  it('is ready only when every target has tracked truth, and never creates labels', () => {
    const entries = scanned(VALUE_READING_ACTIVATION_BAR.minRowsPerClass);
    const all = new Set(entries.map((entry) => entry.identity));
    const ready = proposeQualificationSet({ inventories: [inventory(entries)], labelledIdentities: all });
    expect(ready.classes.find((entry) => entry.task === 'confirm_scanned_amount')).toMatchObject({ status: 'ready', labelled: entries.length });
    const partial = proposeQualificationSet({ inventories: [inventory(entries)],
      labelledIdentities: new Set([...all].slice(1)) });
    expect(partial.classes.find((entry) => entry.task === 'confirm_scanned_amount')).toMatchObject({ status: 'needs_labels', unlabelled: 1 });
  });

  it('counts the same evidence once across inventories and withholds identities that sit in two classes', () => {
    const shared = scanned(5);
    const proposal = proposeQualificationSet({ inventories: [
      inventory([...shared, entry('x', 'withheld_bundle')]),
      inventory([...shared, entry('x', 'legacy_unresolved_line'), entry('v', 'scanned_review_required_value', 'DN', ['category'])]),
    ] });
    const byTask = Object.fromEntries(proposal.classes.map((entry) => [entry.task, entry]));
    expect(byTask.confirm_scanned_amount).toMatchObject({ targets: 6, alsoCategory: 1, documents: { DN: 1, Golden: 5 } });
    expect(proposal.excludedOverlaps).toEqual([{ identity: 'x', classes: ['legacy_unresolved_line', 'withheld_bundle'] }]);
    expect(byTask.read_withheld_line!.targets).toBe(0);
  });

  it('binds a run to an exact, order-independent set', () => {
    const a = proposeQualificationSet({ inventories: [inventory(scanned(4))] });
    const b = proposeQualificationSet({ inventories: [inventory([...scanned(4)].reverse())] });
    const c = proposeQualificationSet({ inventories: [inventory(scanned(5))] });
    expect(a.proposalDigest).toBe(b.proposalDigest);
    expect(a.proposalDigest).not.toBe(c.proposalDigest);
  });
});
