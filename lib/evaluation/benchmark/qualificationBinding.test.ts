import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseBenchmarkLabels } from '@/lib/evaluation/benchmark/benchmarkContract';
import { bindQualificationTargets, type LabelledQualificationPage } from '@/lib/evaluation/benchmark/qualificationBinding';
import { decideQualification } from '@/lib/evaluation/benchmark/qualificationScoring';
import { proposeQualificationSet } from '@/lib/evaluation/benchmark/qualificationSet';
import { classifyReadingFailures, QUALIFICATION_FAILURE_RULES } from '@/lib/evaluation/benchmark/qualificationTaxonomy';
import {
  VALUE_READING_ACTIVATION_BAR,
  VALUE_READING_BENCHMARK_PAGES,
  valueReadingBenchmarkTargets,
  type ValueReadingBenchmarkRecord,
} from '@/lib/evaluation/benchmark/valueReadingBenchmark';
import type { InventoryClass, InventoryEntry, ResolutionEvidenceInventory } from '@/lib/evaluation/resolutionEvidenceInventory';
import type { CanonicalBox } from '@/lib/extraction/geometry/canonicalPageFrame';

/**
 * B4.6.1: a queue case is scored only against the tracked labelled row its own
 * reading region holds; truth never comes from a reading.
 */

const DN = '00000000-0000-4000-8000-0000000000d7';
const dnPage = VALUE_READING_BENCHMARK_PAGES.find((page) => page.pageKey === 'dn-p107')!;
const dnLabels = parseBenchmarkLabels(readFileSync('lib/evaluation/benchmark/labels/dn-p107.labels.json')).labels;
const labelled: LabelledQualificationPage = { page: dnPage, documentId: DN, physicalPageNumber: 107, labels: dnLabels };
const labelTargets = valueReadingBenchmarkTargets(dnLabels, dnPage).targets;
const cells = new Map(dnLabels.cells.items!.map((cell) => [cell.labelId, cell]));
const rowCells = (rowKey: string) =>
  dnLabels.rows.items!.find((row) => row.rowKey === rowKey)!.orderedCellLabelIds.map((id) => cells.get(id)!);
const boxesOf = (rowKey: string, column?: string): CanonicalBox[] => rowCells(rowKey)
  .filter((cell) => column === undefined || cell.columnName === column)
  .map((cell) => ({ coordinate_space: 'canonical_v1', x_min: cell.box.x_min, x_max: cell.box.x_max,
    y_min: cell.box.y_min, y_max: cell.box.y_max }));
const headerRow = dnLabels.rows.items!.find((row) => row.orderedCellLabelIds.some((id) => cells.get(id)!.isHeader))!.rowKey;

function entry(identity: string, inventoryClass: InventoryClass, boxes: CanonicalBox[] | null,
  page = 107, documentId = DN): InventoryEntry {
  return { identity, inventoryClass, documentLabel: 'DN', documentId, physicalPageNumber: page, caseId: `case:${identity}`,
    caseKind: 'review_required_value', tier: 'missing_authoritative_value', rootCauseKey: 'r', diagnosticCode: null,
    alsoUnresolved: [], originalSourceText: null,
    readingRegion: boxes ? { physicalPageNumber: page, anchorKey: identity, canonicalBoxes: boxes } : null };
}
function inventory(entries: InventoryEntry[]): ResolutionEvidenceInventory {
  return { schema: 'resolution_evidence_inventory_v1', documents: [{ documentId: DN, label: 'DN' }], entries,
    countsByClass: {} as never, countsByDocumentAndClass: {}, attachedCategoryRequirements: 0,
    distinctIdentities: entries.length, overlaps: [], unclassifiedKinds: {} };
}
function record(pageKey: string, rowKey: string, overrides: Partial<ValueReadingBenchmarkRecord> = {}): ValueReadingBenchmarkRecord {
  return { pageKey, evidenceClass: 'dense_scanned_ocr_priced_schedule', rowKey, outcome: 'correct',
    fields: { rate: true, unit: true, description: true, category: null }, rateError: null, boundTo: null, inventions: [],
    requestDigestSha256: 'r', outputDigestSha256: 'o', providerCalled: true, failureReason: null,
    renderMs: 100, providerMs: 1000, totalMs: 1100, inputTokens: 1000, outputTokens: 100, usd: 0.01,
    renderDigestSha256: 'd', reuseEligible: true, ...overrides };
}

describe('B4.6.1 target binding: production region to tracked truth', () => {
  const [first, second, third] = labelTargets;

  it('binds a case to the one labelled row its own region holds, cropping what production would send', () => {
    // Production's region is narrower than the labelled row: only description and rate observations.
    const region = [...boxesOf(first!.rowKey, 'Description'), ...boxesOf(first!.rowKey, 'Unit Cost')];
    const result = bindQualificationTargets({ inventories: [inventory([entry('a', 'scanned_review_required_value', region)])],
      labelledPages: [labelled] });
    const [binding] = result.bindings;
    expect(binding).toMatchObject({ status: 'bound', task: 'confirm_scanned_amount', labelRowKey: first!.rowKey,
      evidenceClass: 'dense_scanned_ocr_priced_schedule', pageKey: 'dn-p107', failure: null });
    // Truth is the labelled row; the crop is the case's region, not the labelled row's.
    expect(binding!.target!.truth).toEqual(first!.truth);
    expect(binding!.target!.boxes).toEqual(region);
    expect(binding!.target!.boxes).not.toEqual(first!.boxes);
    expect([...result.labelledIdentities]).toEqual(['a']);
  });

  it('classifies every case that does not bind to exactly one row, before any provider call', () => {
    const result = bindQualificationTargets({ inventories: [inventory([
      entry('spans', 'withheld_bundle', [...boxesOf(second!.rowKey), ...boxesOf(third!.rowKey)]),
      entry('misses', 'legacy_unresolved_line', boxesOf(second!.rowKey, 'Description')),
      entry('header', 'legacy_unresolved_line', boxesOf(headerRow)),
      entry('unproven', 'scanned_review_required_value', null),
      entry('dup-1', 'scanned_review_required_value', boxesOf(third!.rowKey)),
      entry('dup-2', 'withheld_bundle', boxesOf(third!.rowKey, 'Unit Cost')),
    ])], labelledPages: [labelled] });
    const byId = Object.fromEntries(result.bindings.map((binding) => [binding.identity, binding]));
    expect(byId.spans!.failure).toMatchObject({ kind: 'region_spans_rows', owner: 'deterministic_extraction', severity: 'hard' });
    expect(byId.misses!.failure).toMatchObject({ kind: 'region_misses_rate', owner: 'deterministic_extraction' });
    expect(byId.header!.failure).toMatchObject({ kind: 'region_not_priced_row', owner: 'workflow_typing' });
    expect(byId.unproven!.failure).toMatchObject({ kind: 'reading_region_unproven', severity: 'soft' });
    // One physical row, one case: both fail loudly, neither is scored.
    for (const id of ['dup-1', 'dup-2']) {
      expect(byId[id]).toMatchObject({ status: 'binding_failed', target: null,
        failure: { kind: 'duplicate_case_for_row', owner: 'workflow_typing' } });
    }
    expect(result.labelledIdentities.size).toBe(0);
  });

  it('keeps category choice human-only and never invents labels for unlabelled pages', () => {
    const result = bindQualificationTargets({ inventories: [inventory([
      entry('cat', 'category_review', boxesOf(first!.rowKey)),
      entry('p108', 'legacy_unresolved_line', boxesOf(first!.rowKey), 108),
    ])], labelledPages: [labelled] });
    const byId = Object.fromEntries(result.bindings.map((binding) => [binding.identity, binding]));
    expect(byId.cat).toMatchObject({ status: 'human_only', target: null, task: 'choose_category' });
    expect(byId.p108).toMatchObject({ status: 'unlabelled_page', target: null, evidenceClass: null });
  });

  it('feeds the qualification set exactly the bound identities as labelled', () => {
    const entries = labelTargets.slice(0, VALUE_READING_ACTIVATION_BAR.minRowsPerClass)
      .map((target, index) => entry(`s${String(index).padStart(2, '0')}`, 'scanned_review_required_value', boxesOf(target.rowKey)));
    const { labelledIdentities } = bindQualificationTargets({ inventories: [inventory(entries)], labelledPages: [labelled] });
    const proposal = proposeQualificationSet({ inventories: [inventory(entries)], labelledIdentities });
    expect(proposal.classes.find((entry) => entry.task === 'confirm_scanned_amount')).toMatchObject({ status: 'ready' });
  });
});

describe('B4.6.1 taxonomy: every failure has one kind and one owner', () => {
  it('owns a wrong binding by whether the crop showed the copied value', () => {
    const shown = classifyReadingFailures(record('p', 'r', { outcome: 'wrong_rate', rateError: 'wrong_source_region_binding',
      boundTo: { amount: 5, source: 'cell', labelId: 'c', rowKey: 'r2', columnName: 'Rate', inCrop: true } }));
    expect(shown).toEqual([expect.objectContaining({ kind: 'wrong_source_region_binding', owner: 'evidence_context_selection' })]);
    const unseen = classifyReadingFailures(record('p', 'r', { outcome: 'wrong_rate', rateError: 'wrong_source_region_binding',
      boundTo: { amount: 5, source: 'word', labelId: 'w', rowKey: null, columnName: null, inCrop: false } }));
    expect(unseen[0]).toMatchObject({ owner: 'forgewing_prompt_reasoning' });
  });

  it('separates numeric inventions, semantic inventions, field mismatches, output and runtime failures', () => {
    expect(classifyReadingFailures(record('p', 'r', { outcome: 'wrong_rate', rateError: 'unsupported_numeric_invention',
      inventions: ['unit'] })).map((failure) => failure.kind)).toEqual(['unsupported_numeric_invention', 'unsupported_semantic_invention']);
    expect(classifyReadingFailures(record('p', 'r', { outcome: 'field_mismatch',
      fields: { rate: true, unit: true, description: false, category: null } }))).toEqual([
      expect.objectContaining({ kind: 'field_mismatch', detail: 'description', severity: 'soft' })]);
    expect(classifyReadingFailures(record('p', 'r', { outcome: 'failed', fields: null, failureReason: 'provider_timeout' }))[0])
      .toMatchObject({ kind: 'provider_failure', owner: 'provider_runtime' });
    expect(classifyReadingFailures(record('p', 'r', { outcome: 'failed', fields: null, failureReason: 'invalid_json' }))[0])
      .toMatchObject({ kind: 'output_invalid', owner: 'forgewing_prompt_reasoning' });
    expect(classifyReadingFailures(record('p', 'r', { outcome: 'failed', fields: null, providerCalled: false,
      failureReason: 'region_image_unavailable' }))[0]).toMatchObject({ kind: 'crop_unrendered' });
    expect(classifyReadingFailures(record('p', 'r'))).toEqual([]);
    expect(classifyReadingFailures(record('p', 'r', { outcome: 'abstained', fields: null }))).toEqual([]);
    expect(classifyReadingFailures(record('p', 'r', { outcome: 'failed', fields: null, failureReason: 'dry_run' }))).toEqual([]);
  });

  it('gives every kind a correction owner, and keeps zero-tolerance kinds hard', () => {
    for (const rule of Object.values(QUALIFICATION_FAILURE_RULES)) expect(rule.smallestCorrection.length).toBeGreaterThan(0);
    for (const kind of ['unsupported_numeric_invention', 'unsupported_semantic_invention', 'wrong_source_region_binding'] as const) {
      expect(QUALIFICATION_FAILURE_RULES[kind].severity).toBe('hard');
    }
  });
});

describe('B4.6.1 decision: each workflow class alone, against source truth', () => {
  const min = VALUE_READING_ACTIVATION_BAR.minRowsPerClass;
  const bound = labelTargets.slice(0, min).map((target, index) =>
    entry(`s${String(index).padStart(2, '0')}`, 'scanned_review_required_value', boxesOf(target.rowKey)));
  const bindings = bindQualificationTargets({ inventories: [inventory(bound)], labelledPages: [labelled] }).bindings;
  const correct = labelTargets.slice(0, min).map((target) => record('dn-p107', target.rowKey));

  it('qualifies a class only on readings of every bound case, and lists it as activatable', () => {
    const decision = decideQualification({ bindings, records: correct });
    expect(decision.classes).toEqual([expect.objectContaining({ key: 'confirm_scanned_amount:dense_scanned_ocr_priced_schedule',
      status: 'qualified', cases: min, bound: min })]);
    expect(decision.qualifiedClasses).toEqual(['confirm_scanned_amount:dense_scanned_ocr_priced_schedule']);
    expect(decision.activatable).toEqual(['confirm_scanned_amount']);
    // A dry run renders but reads nothing: never a decision.
    const dry = decideQualification({ bindings, records: correct.map((entry) => ({ ...entry, failureReason: 'dry_run',
      outcome: 'failed' as const, fields: null })) });
    expect(dry.classes[0]).toMatchObject({ status: 'not_run' });
    expect(dry.activatable).toEqual([]);
  });

  it('never activates a task while any of its evidence classes is undecided: production gates by task', () => {
    // The dense-scan class qualifies, but the same task has price-sheet cases on an unlabelled page.
    const elsewhere = [...bound, ...Array.from({ length: min }, (_, index) =>
      entry(`p${index}`, 'scanned_review_required_value', boxesOf(labelTargets[0]!.rowKey), 10, '00000000-0000-4000-8000-0000000000aa'))];
    const withElsewhere = bindQualificationTargets({ inventories: [inventory(elsewhere)], labelledPages: [labelled] }).bindings;
    const decision = decideQualification({ bindings: withElsewhere, records: correct,
      evidenceClassOfPage: new Map([['DN:10', 'ocr_price_sheet']]) });
    expect(decision.qualifiedClasses).toEqual(['confirm_scanned_amount:dense_scanned_ocr_priced_schedule']);
    expect(decision.classes.map((entry) => [entry.key, entry.status])).toContainEqual(['confirm_scanned_amount:ocr_price_sheet', 'needs_labels']);
    expect(decision.activatable).toEqual([]);
  });

  it('fails every class on one zero-tolerance failure anywhere, with its owner', () => {
    const records = correct.map((entry, index) => index === 0 ? { ...entry, outcome: 'wrong_rate' as const,
      fields: { rate: false, unit: true, description: true, category: null }, rateError: 'unsupported_numeric_invention' as const } : entry);
    const decision = decideQualification({ bindings, records });
    expect(decision.corpusSafetyFailures).toEqual(['1 unsupported numeric invention(s)']);
    expect(decision.classes[0]).toMatchObject({ status: 'failed', failuresByOwner: { forgewing_prompt_reasoning: 1 } });
    expect(decision.activatable).toEqual([]);
    expect(decision.provisional).toBe(true);
  });

  it('does not decide a class with unlabelled, unbindable, too few or human-only cases', () => {
    const unlabelled = [...bound, entry('far', 'scanned_review_required_value', boxesOf(labelTargets[0]!.rowKey), 108)];
    const withFar = bindQualificationTargets({ inventories: [inventory(unlabelled)], labelledPages: [labelled] }).bindings;
    expect(decideQualification({ bindings: withFar, records: correct,
      evidenceClassOfPage: new Map([['DN:108', 'dense_scanned_ocr_priced_schedule']]) }).classes[0])
      .toMatchObject({ status: 'needs_labels', unlabelled: 1 });

    const spans = [...bound.slice(1), entry('spans', 'scanned_review_required_value',
      [...boxesOf(labelTargets[0]!.rowKey), ...boxesOf(labelTargets[min]!.rowKey)])];
    const spanBindings = bindQualificationTargets({ inventories: [inventory(spans)], labelledPages: [labelled] }).bindings;
    expect(decideQualification({ bindings: spanBindings, records: correct }).classes[0])
      .toMatchObject({ status: 'binding_failed', failuresByOwner: { deterministic_extraction: 1 } });

    const few = bindQualificationTargets({ inventories: [inventory(bound.slice(0, 3))], labelledPages: [labelled] }).bindings;
    expect(decideQualification({ bindings: few, records: correct }).classes[0]).toMatchObject({ status: 'insufficient_targets' });

    const category = bindQualificationTargets({ inventories: [inventory(labelTargets.slice(0, min)
      .map((target, index) => entry(`c${index}`, 'category_review', boxesOf(target.rowKey))))], labelledPages: [labelled] }).bindings;
    expect(decideQualification({ bindings: category, records: correct }).classes[0])
      .toMatchObject({ key: 'choose_category:dense_scanned_ocr_priced_schedule', status: 'human_only' });
  });
});
