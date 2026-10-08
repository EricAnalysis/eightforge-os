import type { ValueReadingBenchmarkRecord } from '@/lib/evaluation/benchmark/valueReadingBenchmark';

/**
 * B4.6.1 failure taxonomy. Pre-registered, pure: every qualification failure
 * gets exactly one kind, and every kind exactly one owner, decided by fixed
 * rules from the scored record or the target binding, never by judgment after
 * seeing results. The owner names who makes the smallest correction; the
 * taxonomy never makes it.
 */

export const QUALIFICATION_TAXONOMY_VERSION = 'b461-failure-taxonomy-v1' as const;

/** Who owns the correction. */
export type QualificationFailureOwner =
  /** Rows, regions, OCR and geometry: Codex-owned deterministic extraction. */
  | 'deterministic_extraction'
  /** What the crop and context show the reader. */
  | 'evidence_context_selection'
  /** The prompt, output schema and the reader's reasoning. */
  | 'forgewing_prompt_reasoning'
  /** Which workflow class a case is, and whether it is a reading task at all. */
  | 'workflow_typing'
  /** Typed actions, reviewed-truth writes and gates; proven by CI, not by a run. */
  | 'authority_action_wiring'
  /** The provider, the renderer and the runtime they run on. */
  | 'provider_runtime';

export type QualificationFailureKind =
  // Zero-tolerance reading failures (hard, corpus-wide).
  | 'unsupported_numeric_invention'
  | 'unsupported_semantic_invention'
  | 'wrong_source_region_binding'
  // Reading failures that cost precision or coverage.
  | 'field_mismatch'
  | 'output_invalid'
  | 'provider_failure'
  | 'crop_unrendered'
  // Binding failures: found before any provider call, from the region production would send.
  | 'region_spans_rows'
  | 'region_misses_rate'
  | 'region_not_priced_row'
  | 'duplicate_case_for_row'
  | 'reading_region_unproven'
  // Class-level bars.
  | 'latency'
  | 'cost';

export type QualificationFailureSeverity =
  /** Disqualifies the class (or the corpus, for the zero-tolerance kinds). */
  | 'hard'
  /** Costs coverage or precision; judged by the bar, not alone. */
  | 'soft';

export type QualificationFailureRule = Readonly<{
  owner: QualificationFailureOwner;
  severity: QualificationFailureSeverity;
  /** The smallest correction this kind calls for, owned by `owner`. */
  smallestCorrection: string;
}>;

export const QUALIFICATION_FAILURE_RULES: Readonly<Record<QualificationFailureKind, QualificationFailureRule>> = Object.freeze({
  unsupported_numeric_invention: { owner: 'forgewing_prompt_reasoning', severity: 'hard',
    smallestCorrection: 'Prompt or schema: require the rate to be read from the target cell, and "unreadable" otherwise.' },
  unsupported_semantic_invention: { owner: 'forgewing_prompt_reasoning', severity: 'hard',
    smallestCorrection: 'Prompt: a unit or category only as printed on the target row (or its allowed section heading); else null.' },
  wrong_source_region_binding: { owner: 'forgewing_prompt_reasoning', severity: 'hard',
    smallestCorrection: 'Prompt: read only the target row; a value from another row is never an answer.' },
  field_mismatch: { owner: 'forgewing_prompt_reasoning', severity: 'soft',
    smallestCorrection: 'Prompt: copy description and unit verbatim from the target row.' },
  output_invalid: { owner: 'forgewing_prompt_reasoning', severity: 'soft',
    smallestCorrection: 'Prompt or output schema: the answer must parse and pass deterministic validation.' },
  provider_failure: { owner: 'provider_runtime', severity: 'soft',
    smallestCorrection: 'Runtime: timeout budget, retry policy or provider availability.' },
  crop_unrendered: { owner: 'provider_runtime', severity: 'soft',
    smallestCorrection: 'Renderer: the crop for a proven region must draw.' },
  region_spans_rows: { owner: 'deterministic_extraction', severity: 'hard',
    smallestCorrection: 'Extraction: split the line so one case carries one row (row segmentation, continuation attribution).' },
  region_misses_rate: { owner: 'deterministic_extraction', severity: 'hard',
    smallestCorrection: 'Extraction: the case region must include the row\'s rate cell (column geometry).' },
  region_not_priced_row: { owner: 'workflow_typing', severity: 'hard',
    smallestCorrection: 'Typing: a line that is not a priced row is not a reading task (disposition or structure case).' },
  duplicate_case_for_row: { owner: 'workflow_typing', severity: 'hard',
    smallestCorrection: 'Typing: one physical row, one reading case; dedupe by row before the queue.' },
  reading_region_unproven: { owner: 'deterministic_extraction', severity: 'soft',
    smallestCorrection: 'Extraction: persist canonical geometry for every source observation of the line.' },
  latency: { owner: 'provider_runtime', severity: 'hard',
    smallestCorrection: 'Runtime: render or provider latency within the pre-registered wait bars.' },
  cost: { owner: 'provider_runtime', severity: 'hard',
    smallestCorrection: 'Runtime or prompt: tokens per call within the pre-registered spend bars.' },
});

/**
 * A wrong confident rate copied from a value the crop itself showed is a
 * context failure: the crop handed the reader another row's number. One the
 * crop did not show is the reader's.
 */
export function wrongBindingOwner(record: Pick<ValueReadingBenchmarkRecord, 'boundTo'>): QualificationFailureOwner {
  return record.boundTo?.inCrop ? 'evidence_context_selection' : 'forgewing_prompt_reasoning';
}

export type QualificationFailure = Readonly<{
  kind: QualificationFailureKind;
  owner: QualificationFailureOwner;
  severity: QualificationFailureSeverity;
  /** The detail that classified it (for example the provider failure code). Never row text. */
  detail: string | null;
}>;

function failure(kind: QualificationFailureKind, detail: string | null = null,
  owner: QualificationFailureOwner = QUALIFICATION_FAILURE_RULES[kind].owner): QualificationFailure {
  return { kind, owner, severity: QUALIFICATION_FAILURE_RULES[kind].severity, detail };
}

/** Failure reasons the run records (valueReadingBenchmarkRun), by what failed. */
const PROVIDER_FAILURE_REASONS = new Set(['provider_timeout', 'provider_truncated_output', 'provider_error']);
const UNRENDERED_REASON = 'region_image_unavailable';

/** Every failure one scored reading shows; empty for a correct reading or an honest abstention. */
export function classifyReadingFailures(record: ValueReadingBenchmarkRecord): readonly QualificationFailure[] {
  const failures: QualificationFailure[] = [];
  if (record.outcome === 'failed') {
    const reason = record.failureReason ?? 'unknown';
    // A dry run measures rendering only: nothing was read, so nothing failed.
    if (reason === 'dry_run') return [];
    if (reason === UNRENDERED_REASON) return [failure('crop_unrendered', reason)];
    // Anything else after a call is the answer itself (invalid JSON, proposal, validation).
    return [PROVIDER_FAILURE_REASONS.has(reason) ? failure('provider_failure', reason) : failure('output_invalid', reason)];
  }
  if (record.rateError === 'unsupported_numeric_invention') failures.push(failure('unsupported_numeric_invention'));
  if (record.rateError === 'wrong_source_region_binding') {
    failures.push(failure('wrong_source_region_binding', record.boundTo?.inCrop ? 'value shown in crop' : 'value outside crop',
      wrongBindingOwner(record)));
  }
  for (const field of record.inventions) failures.push(failure('unsupported_semantic_invention', field));
  if (record.outcome === 'field_mismatch' && record.inventions.length === 0) {
    const fields = record.fields;
    const wrong = fields ? (['description', 'unit', 'category'] as const).filter((name) => fields[name] === false) : [];
    failures.push(failure('field_mismatch', wrong.join(',') || null));
  }
  return failures;
}

/** A binding failure, as the taxonomy classifies it. */
export function bindingFailure(kind: Extract<QualificationFailureKind,
  'region_spans_rows' | 'region_misses_rate' | 'region_not_priced_row' | 'duplicate_case_for_row' | 'reading_region_unproven'>,
  detail: string | null = null): QualificationFailure {
  return failure(kind, detail);
}

/** A class-level bar failure. */
export function barFailure(kind: 'latency' | 'cost', detail: string): QualificationFailure {
  return failure(kind, detail);
}
