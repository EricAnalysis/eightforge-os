import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bindPhase17Labels,
  buildPhase17LabelTemplate,
  parsePhase17LabelSet,
  serializePhase17LabelSet,
} from '@/lib/evaluation/forgewing/phase17/dnContinuationLabels';
import {
  PHASE17_DN_CORPUS,
  Phase17LabelSetSchema,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';
import {
  syntheticPhase17Cohort,
  syntheticPhase17Labels,
} from '@/lib/evaluation/forgewing/phase17/__fixtures__/phase17SyntheticCohort';

const COMMITTED_LABELS = path.join(process.cwd(), 'lib/evaluation/fixtures/dnContinuationLabels.v1.json');

describe('Phase 17 human label contract', () => {
  it('commits a label artifact pinned to the DN corpus and harness identity, with ids only', () => {
    const bytes = readFileSync(COMMITTED_LABELS, 'utf8');
    const { labelSet } = parsePhase17LabelSet(bytes);
    expect(labelSet.corpus).toEqual({ sha256: PHASE17_DN_CORPUS.sha256,
      byteLength: PHASE17_DN_CORPUS.byteLength, physicalPageNumber: 106 });
    expect(labelSet.units).toHaveLength(13);
    expect(new Set(labelSet.units.flatMap((unit) => unit.candidateIds)).size).toBe(26);
    // No source text: every string is an identifier, a digest, a label value, or provenance.
    const allowedKeys = new Set(['labelSetVersion', 'authority', 'recoveryType', 'corpus', 'sha256',
      'byteLength', 'physicalPageNumber', 'harnessIdentity', 'sourceDocumentId', 'sourceArtifactId',
      'pageRepresentationDigest', 'units', 'unitKey', 'candidateIds', 'expected', 'labeledBy',
      'labeledAt', 'note']);
    const keys = [...bytes.matchAll(/"([A-Za-z]+)":/g)].map((match) => match[1]!);
    expect(keys.filter((key) => !allowedKeys.has(key))).toEqual([]);
    for (const unit of labelSet.units) {
      if (unit.expected !== null && unit.expected !== 'human_indeterminate') {
        expect(unit.candidateIds).toContain(unit.expected);
      }
    }
  });

  it('keeps an unlabeled template unlabeled: nothing but a human fills expected', () => {
    const template = buildPhase17LabelTemplate(syntheticPhase17Cohort());
    expect(template.units.every((unit) =>
      unit.expected === null && unit.labeledBy === null && unit.labeledAt === null)).toBe(true);
    const bound = bindPhase17Labels(parsePhase17LabelSet(serializePhase17LabelSet(template)),
      syntheticPhase17Cohort());
    expect(bound.state).toBe('incomplete');
    expect(bound.unlabeledUnitKeys).toHaveLength(13);
  });

  it('accepts human_indeterminate and reports a complete label set', () => {
    const cohort = syntheticPhase17Cohort();
    const labels = syntheticPhase17Labels(cohort, {
      indeterminateUnitKeys: [cohort.units[0]!.unitKey] });
    const bound = bindPhase17Labels(parsePhase17LabelSet(JSON.stringify(labels)), cohort);
    expect(bound.state).toBe('complete');
    expect(bound.expectedByUnitKey.get(cohort.units[0]!.unitKey)).toBe('human_indeterminate');
  });

  it('rejects an expected value outside the unit, or a label without provenance', () => {
    const cohort = syntheticPhase17Cohort();
    const labels = syntheticPhase17Labels(cohort);
    const foreign = labels.units[1]!.candidateIds[0]!;
    expect(Phase17LabelSetSchema.safeParse({ ...labels, units: labels.units.map((unit, index) =>
      index === 0 ? { ...unit, expected: foreign } : unit) }).success).toBe(false);
    expect(Phase17LabelSetSchema.safeParse({ ...labels, units: labels.units.map((unit, index) =>
      index === 0 ? { ...unit, labeledBy: null } : unit) }).success).toBe(false);
    expect(Phase17LabelSetSchema.safeParse({ ...labels, units: labels.units.map((unit, index) =>
      index === 0 ? { ...unit, candidateIds: [unit.candidateIds[0], unit.candidateIds[0]] } : unit) })
      .success).toBe(false);
  });

  it('fails binding when a candidate id, a unit, or the corpus identity differs', () => {
    const cohort = syntheticPhase17Cohort();
    const labels = syntheticPhase17Labels(cohort);
    const changedId = { ...labels, units: labels.units.map((unit, index) => index === 0
      ? { ...unit, candidateIds: [unit.candidateIds[0]!, `recovery-candidate-v2-${'f'.repeat(64)}`],
        expected: unit.candidateIds[0]! } : unit) };
    expect(() => bindPhase17Labels(parsePhase17LabelSet(JSON.stringify(changedId)), cohort))
      .toThrow(/label_binding_failed/i);
    expect(() => bindPhase17Labels(parsePhase17LabelSet(JSON.stringify(labels)),
      { ...cohort, corpusByteLength: 1 })).toThrow(/label_binding_failed/i);
    expect(() => parsePhase17LabelSet('{"not":"labels"}')).toThrow(/label_schema_invalid/i);
  });

  it('digests label content, not checkout line endings', () => {
    const labels = serializePhase17LabelSet(buildPhase17LabelTemplate(syntheticPhase17Cohort()));
    expect(parsePhase17LabelSet(labels).labelSetSha256)
      .toBe(parsePhase17LabelSet(labels.replace(/\n/g, '\r\n')).labelSetSha256);
  });
});
