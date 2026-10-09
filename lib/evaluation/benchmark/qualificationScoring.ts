import type { QualificationTargetBinding } from '@/lib/evaluation/benchmark/qualificationBinding';
import type { QualificationExcludedCase, QualificationExclusionPartition } from '@/lib/evaluation/benchmark/qualificationExclusions';
import { QUALIFICATION_TASKS, type QualificationTask } from '@/lib/evaluation/benchmark/qualificationSet';
import {
  barFailure,
  classifyReadingFailures,
  QUALIFICATION_TAXONOMY_VERSION,
  type QualificationFailure,
  type QualificationFailureOwner,
} from '@/lib/evaluation/benchmark/qualificationTaxonomy';
import {
  summarizeValueReadingClass,
  VALUE_READING_ACTIVATION_BAR,
  VALUE_READING_AUTHORITY_INVARIANTS,
  type ValueReadingBenchmarkRecord,
  type ValueReadingClassSummary,
  type ValueReadingEvidenceClass,
} from '@/lib/evaluation/benchmark/valueReadingBenchmark';

/**
 * B4.6.1 per-class qualification decision. Pure. Each workflow class (task x
 * evidence class) is decided alone, against the unchanged pre-registered bar
 * (VALUE_READING_ACTIVATION_BAR) and the B4.6 per-class summary; classes are
 * never pooled, and an aggregate never activates anything. The zero-tolerance
 * safety bars stay corpus-wide: one occurrence anywhere fails every class.
 *
 * Every failure is classified by the B4.6.1 taxonomy with its owner. A class
 * whose cases cannot all be bound to tracked truth is not decided.
 */

export const QUALIFICATION_DECISION_VERSION = 'b461-qualification-decision-v1' as const;

export type QualificationClassStatus =
  /** Met every hard bar at full coverage. May be proposed for activation. */
  | 'qualified'
  /** Met every hard bar below the coverage target. May be proposed, limited. */
  | 'qualified_low_coverage'
  | 'failed'
  /** Some cases are on pages without tracked labels: not decidable yet. */
  | 'needs_labels'
  /** Fewer cases than the bar's minimum: cannot qualify, never padded. */
  | 'insufficient_targets'
  /** No objective source answer: a person decides; never benchmarked. */
  | 'human_only'
  /**
   * Some production cases do not bind to exactly one labelled row: what
   * production would ask cannot be scored objectively, so the class cannot be
   * qualified until the owner (see failures) corrects it.
   */
  | 'binding_failed'
  /** Bound, but the run has no reading for every bound case. */
  | 'not_run';

export type QualificationClassDecision = Readonly<{
  key: string;
  task: QualificationTask;
  evidenceClass: ValueReadingEvidenceClass | 'unclassified';
  status: QualificationClassStatus;
  cases: number;
  bound: number;
  unlabelled: number;
  bindingFailures: number;
  /** The B4.6 summary over the bound cases' readings; null until every bound case was read. */
  summary: ValueReadingClassSummary | null;
  /** Every classified failure, by owner: binding failures and reading failures alike. */
  failuresByOwner: Readonly<Partial<Record<QualificationFailureOwner, number>>>;
  failures: readonly Readonly<{ identity: string; failure: QualificationFailure }>[];
  reasons: readonly string[];
}>;

export type QualificationDecision = Readonly<{
  version: typeof QUALIFICATION_DECISION_VERSION;
  taxonomyVersion: typeof QUALIFICATION_TAXONOMY_VERSION;
  classes: readonly QualificationClassDecision[];
  /** Human-excluded cases are reported separately and never enter any score or denominator. */
  excludedCases: readonly QualificationExcludedCase[];
  exclusionBlockers: readonly string[];
  /** Zero-tolerance failures anywhere on the corpus: they fail every class. */
  corpusSafetyFailures: readonly string[];
  /** Classes (task x evidence class) that met every hard bar. */
  qualifiedClasses: readonly string[];
  /**
   * Tasks that may be proposed for operator-assist activation. Production gates
   * reading by case family (the task), not by evidence class, so a task is
   * activatable only when every one of its evidence classes qualified: a class
   * that is unlabelled, unbindable, too small or failed blocks its task.
   */
  activatable: readonly QualificationTask[];
  /** True while any disagreement awaits a human ruling. */
  provisional: boolean;
  authorityInvariants: typeof VALUE_READING_AUTHORITY_INVARIANTS;
}>;

const recordKey = (pageKey: string, rowKey: string) => `${pageKey}/${rowKey}`;

export function decideQualification(params: Readonly<{
  bindings: readonly QualificationTargetBinding[];
  /** Scored readings (adjudications applied), keyed by labelled page and row. */
  records: readonly ValueReadingBenchmarkRecord[];
  /** Evidence classes of unlabelled pages, by `documentLabel:page`, where known. */
  evidenceClassOfPage?: ReadonlyMap<string, ValueReadingEvidenceClass>;
  bar?: typeof VALUE_READING_ACTIVATION_BAR;
  exclusions?: QualificationExclusionPartition;
}>): QualificationDecision {
  const bar = params.bar ?? VALUE_READING_ACTIVATION_BAR;
  const excludedCases = params.exclusions?.excludedCases ?? [];
  const exclusionBlockers = params.exclusions?.pending ?? [];
  const excludedIds = new Set(excludedCases.map((entry) => entry.binding.identity));
  const eligibleBindings = params.bindings.filter((binding) => !excludedIds.has(binding.identity));
  const recordsByRow = new Map(params.records.map((record) => [recordKey(record.pageKey, record.rowKey), record]));
  const classOf = (binding: QualificationTargetBinding): ValueReadingEvidenceClass | 'unclassified' =>
    binding.evidenceClass
      ?? params.evidenceClassOfPage?.get(`${binding.documentLabel}:${binding.physicalPageNumber}`) ?? 'unclassified';

  const groups = new Map<string, QualificationTargetBinding[]>();
  for (const binding of params.bindings) {
    const key = `${binding.task}:${classOf(binding)}`;
    groups.set(key, [...(groups.get(key) ?? []), ...(excludedIds.has(binding.identity) ? [] : [binding])]);
  }

  // Every bound case's reading, for the corpus-wide safety bars.
  const allRead = eligibleBindings.flatMap((binding) => {
    const record = binding.status === 'bound' ? recordsByRow.get(recordKey(binding.pageKey!, binding.labelRowKey!)) : undefined;
    return record ? [record] : [];
  });
  const overall = summarizeValueReadingClass('all', allRead, bar);
  const corpusSafetyFailures = [
    overall.accuracy.wrongSourceRegionBindings > bar.maxWrongSourceRegionBindings
      ? `${overall.accuracy.wrongSourceRegionBindings} wrong source-region binding(s)` : null,
    overall.accuracy.unsupportedNumericInventions > bar.maxUnsupportedNumericInventions
      ? `${overall.accuracy.unsupportedNumericInventions} unsupported numeric invention(s)` : null,
    overall.accuracy.unsupportedValueInventions > bar.maxUnsupportedValueInventions
      ? `${overall.accuracy.unsupportedValueInventions} unsupported semantic invention(s)` : null,
  ].filter((entry): entry is string => entry !== null);

  const order = (key: string) => QUALIFICATION_TASKS.indexOf(key.split(':')[0] as QualificationTask);
  const classes: QualificationClassDecision[] = [...groups].sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b)).map(([key, bindings]) => {
    const [task, evidenceClass] = key.split(':') as [QualificationTask, ValueReadingEvidenceClass | 'unclassified'];
    const bound = bindings.filter((binding) => binding.status === 'bound');
    const unlabelled = bindings.filter((binding) => binding.status === 'unlabelled_page').length;
    const humanOnly = bindings.length > 0 && bindings.every((binding) => binding.status === 'human_only');
    const records = bound.flatMap((binding) => {
      const record = recordsByRow.get(recordKey(binding.pageKey!, binding.labelRowKey!));
      return record ? [record] : [];
    });
    const failures: { identity: string; failure: QualificationFailure }[] = [];
    for (const binding of bindings) if (binding.failure) failures.push({ identity: binding.identity, failure: binding.failure });
    for (const binding of bound) {
      const record = recordsByRow.get(recordKey(binding.pageKey!, binding.labelRowKey!));
      for (const failure of record ? classifyReadingFailures(record) : []) failures.push({ identity: binding.identity, failure });
    }
    const allRun = bound.length > 0 && records.length === bound.length && records.every((record) => record.failureReason !== 'dry_run');
    const summary = allRun ? summarizeValueReadingClass(key as ValueReadingClassSummary['evidenceClass'], records, bar) : null;
    if (summary) {
      for (const text of summary.failures) {
        if (/wait|latency/.test(text)) failures.push({ identity: key, failure: barFailure('latency', text) });
        if (/cost/.test(text)) failures.push({ identity: key, failure: barFailure('cost', text) });
      }
    }
    const reasons: string[] = [];
    let status: QualificationClassStatus;
    const hardBindingFailures = failures.filter((entry) => entry.failure.severity === 'hard'
      && ['region_spans_rows', 'region_misses_rate', 'region_not_priced_row', 'duplicate_case_for_row'].includes(entry.failure.kind));
    if (humanOnly) {
      status = 'human_only';
      reasons.push(bindings[0]!.reason ?? 'no objective source answer');
    } else if (bindings.length < bar.minRowsPerClass) {
      status = 'insufficient_targets';
      reasons.push(`${bindings.length} cases; at least ${bar.minRowsPerClass} are needed to qualify`);
    } else if (unlabelled > 0) {
      status = 'needs_labels';
      reasons.push(`${unlabelled} of ${bindings.length} cases are on pages without tracked labels`);
    } else if (hardBindingFailures.length > 0) {
      status = 'binding_failed';
      reasons.push(`${hardBindingFailures.length} case(s) cannot bind to one labelled row`);
    } else if (!summary) {
      status = 'not_run';
      reasons.push(`${records.filter((record) => record.failureReason !== 'dry_run').length} of ${bound.length} bound cases read`);
    } else if (corpusSafetyFailures.length > 0) {
      status = 'failed';
      reasons.push(...corpusSafetyFailures.map((text) => `corpus safety: ${text}`));
    } else {
      status = summary.status;
      reasons.push(...summary.failures, ...summary.shortfalls);
    }
    const failuresByOwner: Partial<Record<QualificationFailureOwner, number>> = {};
    for (const entry of failures) failuresByOwner[entry.failure.owner] = (failuresByOwner[entry.failure.owner] ?? 0) + 1;
    return { key, task, evidenceClass, status, cases: bindings.length, bound: bound.length, unlabelled,
      bindingFailures: bindings.filter((binding) => binding.status === 'binding_failed').length,
      summary, failuresByOwner, failures, reasons };
  });

  const provisional = overall.unadjudicatedDisagreements > 0;
  const qualified = (entry: QualificationClassDecision) => entry.status === 'qualified' || entry.status === 'qualified_low_coverage';
  const qualifiedClasses = provisional || exclusionBlockers.length > 0 ? [] : classes.filter(qualified).map((entry) => entry.key);
  return {
    version: QUALIFICATION_DECISION_VERSION,
    taxonomyVersion: QUALIFICATION_TAXONOMY_VERSION,
    classes,
    excludedCases,
    exclusionBlockers,
    corpusSafetyFailures,
    qualifiedClasses,
    activatable: QUALIFICATION_TASKS.filter((task) => {
      const ofTask = classes.filter((entry) => entry.task === task);
      return ofTask.length > 0 && ofTask.every((entry) => qualifiedClasses.includes(entry.key));
    }),
    provisional,
    authorityInvariants: VALUE_READING_AUTHORITY_INVARIANTS,
  };
}
