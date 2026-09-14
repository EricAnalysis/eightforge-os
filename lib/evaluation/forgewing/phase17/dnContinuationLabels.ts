import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { Phase17Cohort } from '@/lib/evaluation/forgewing/phase17/dnContinuationCohort';
import {
  PHASE17_DN_CORPUS,
  PHASE17_HARNESS_IDENTITY,
  PHASE17_HUMAN_INDETERMINATE,
  PHASE17_RECOVERY_TYPE,
  Phase17LabelSetSchema,
  type Phase17LabelSet,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

/**
 * Human ground truth for Phase 17.
 *
 * The label artifact is authored by a person reading the source document. This
 * module only validates it and binds it to the regenerated cohort; it never
 * fills in an expected value, and nothing here can reach a provider. Labels are
 * evaluation-only and must never be read by production recovery.
 */

export class Phase17LabelError extends Error {
  constructor(readonly code: 'label_schema_invalid' | 'label_binding_failed', detail: string) {
    super(`PHASE17_LABELS_${code.toUpperCase()}: ${detail}`);
    this.name = 'Phase17LabelError';
  }
}

export type Phase17BoundLabels = Readonly<{
  labelSet: Phase17LabelSet;
  labelSetSha256: string;
  state: 'complete' | 'incomplete';
  unlabeledUnitKeys: readonly string[];
  expectedByUnitKey: ReadonlyMap<string, string | typeof PHASE17_HUMAN_INDETERMINATE | null>;
}>;

export function parsePhase17LabelSet(bytes: Uint8Array | string): Readonly<{
  labelSet: Phase17LabelSet;
  labelSetSha256: string;
}> {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  let json: unknown;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Phase17LabelError('label_schema_invalid', 'label artifact is not JSON');
  }
  const parsed = Phase17LabelSetSchema.safeParse(json);
  if (!parsed.success) {
    throw new Phase17LabelError('label_schema_invalid',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  // Canonical content digest, not file bytes: checkout end-of-line translation
  // must not change the identity of the same human labels.
  return { labelSet: parsed.data, labelSetSha256: hashCanonical(parsed.data) };
}

/**
 * Binds labels to the regenerated cohort by exact unit key and exact candidate
 * id set. Any difference -- a missing unit, an extra unit, a changed candidate
 * id -- means the labels describe a different candidate contract and fails.
 */
export function bindPhase17Labels(
  parsed: Readonly<{ labelSet: Phase17LabelSet; labelSetSha256: string }>,
  cohort: Phase17Cohort,
): Phase17BoundLabels {
  const { labelSet } = parsed;
  if (labelSet.corpus.sha256 !== cohort.corpusSha256
    || labelSet.corpus.byteLength !== cohort.corpusByteLength) {
    throw new Phase17LabelError('label_binding_failed', 'label corpus identity differs from the cohort');
  }
  const labelUnits = new Map(labelSet.units.map((unit) => [unit.unitKey, unit]));
  const problems: string[] = [];
  for (const unit of cohort.units) {
    const label = labelUnits.get(unit.unitKey);
    if (!label) {
      problems.push(`missing label unit ${unit.unitKey}`);
      continue;
    }
    const expectedIds = unit.canonicalCandidates.map((candidate) => candidate.candidateId).sort();
    const labelIds = [...label.candidateIds].sort();
    if (expectedIds.join('|') !== labelIds.join('|')) {
      problems.push(`candidate ids differ for ${unit.unitKey}`);
    }
  }
  const cohortKeys = new Set(cohort.units.map((unit) => unit.unitKey));
  for (const key of labelUnits.keys()) {
    if (!cohortKeys.has(key)) problems.push(`label unit ${key} is not in the cohort`);
  }
  if (problems.length > 0) {
    throw new Phase17LabelError('label_binding_failed', problems.join('; '));
  }
  const unlabeledUnitKeys = labelSet.units
    .filter((unit) => unit.expected === null)
    .map((unit) => unit.unitKey)
    .sort();
  return {
    labelSet,
    labelSetSha256: parsed.labelSetSha256,
    state: unlabeledUnitKeys.length === 0 ? 'complete' : 'incomplete',
    unlabeledUnitKeys,
    expectedByUnitKey: new Map(labelSet.units.map((unit) => [unit.unitKey, unit.expected])),
  };
}

/**
 * An unlabeled template bound to the cohort. Every `expected` is null: a human
 * must supply each one. Contains ids only -- no source text.
 */
export function buildPhase17LabelTemplate(cohort: Phase17Cohort): Phase17LabelSet {
  return Phase17LabelSetSchema.parse({
    labelSetVersion: 'dn-continuation-labels-v1',
    authority: 'human_evaluation_ground_truth_only',
    recoveryType: PHASE17_RECOVERY_TYPE,
    corpus: {
      sha256: cohort.corpusSha256,
      byteLength: cohort.corpusByteLength,
      physicalPageNumber: PHASE17_DN_CORPUS.physicalPageNumber,
    },
    harnessIdentity: { ...PHASE17_HARNESS_IDENTITY },
    units: cohort.units.map((unit) => ({
      unitKey: unit.unitKey,
      candidateIds: unit.canonicalCandidates.map((candidate) => candidate.candidateId),
      expected: null,
      labeledBy: null,
      labeledAt: null,
      note: null,
    })),
  });
}

export function serializePhase17LabelSet(labelSet: Phase17LabelSet): string {
  return `${JSON.stringify(labelSet, null, 2)}\n`;
}
