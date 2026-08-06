/**
 * The single orchestration entry point for non-serving authority comparison.
 *
 * ## What makes this safe
 *
 * The comparator reaches the validator through exactly two pure functions:
 * `buildValidatorInputFromSourceSnapshot` and `executeProjectValidation`. Neither
 * persists, publishes, notifies, transitions a workflow, nor mutates project or
 * clearance state — all of that lives in `runValidationFlow` ABOVE this module,
 * which the comparator never calls. Side-effect isolation is therefore structural
 * rather than a discipline the comparator has to maintain.
 *
 * ## Non-serving by construction
 *
 * `runProjectTruthAuthorityComparison` returns a `ProjectTruthAuthorityComparison`
 * and nothing else. No servable validation payload type is imported, named, or
 * re-exported anywhere in this module, so there is nothing a caller could
 * accidentally serve. The two in-memory validation outcomes are consumed by the
 * normalizer inside one private helper and dropped when it returns. The
 * architecture boundary test asserts this module never names a servable result
 * type, so restoring one would fail the build rather than pass unnoticed.
 *
 * ## Order independence
 *
 * Legacy runs first and canonical second, but the result cannot depend on that:
 * both inputs are built from the same frozen snapshot, and the input digest is
 * recomputed after each run to prove neither run mutated shared source data. If a
 * mutation is ever detected the comparison fails honestly instead of reporting a
 * delta caused by its own contamination.
 */

import { canonicalJson, sha256Hex } from '@/lib/canonical/publication/projectTruthPublicationIdentity';
import {
  buildValidatorInputFromSourceSnapshot,
  executeProjectValidation,
  loadValidatorSourceSnapshot,
  type ValidatorSourceSnapshot,
} from '@/lib/validator/projectValidator';

import {
  buildAuthorityComparisonDeltaGroups,
  buildAuthorityComparisonDeltas,
  summarizeClassifications,
} from './authorityComparisonDelta';
import {
  PROJECT_TRUTH_AUTHORITY_COMPARISON_VERSION,
  type AuthorityComparisonOutcome,
  type AuthorityRunSummary,
  type ComparisonStatus,
  type FailedAuthorityComparison,
  type OperatorDispositionRecord,
  type OperatorDispositionSummary,
  type ProjectTruthAuthorityComparison,
} from './authorityComparisonModel';
import {
  alignedPricingReferences,
  normalizeAuthorityRun,
} from './authorityRunNormalization';
import { alignPricingObservations } from './pricingObservationAlignment';
import { buildComparisonInputSnapshotDigest } from './comparisonInputDigest';

/**
 * Projects currently inside a comparison.
 *
 * Re-entrancy is already structurally impossible — the comparator calls only pure
 * validator functions, never the serving flow — but the guard is explicit and
 * testable so a future caller cannot reintroduce recursion by wiring the
 * comparator into a path the comparator itself reaches.
 */
const inFlight = new Set<string>();

export type AuthorityComparisonRunOptions = {
  /**
   * Reuse an already-loaded snapshot. The serving path passes the snapshot it
   * already loaded so the whole execution reads the database exactly once.
   */
  readonly sourceSnapshot?: ValidatorSourceSnapshot;
  /** Operator dispositions recorded against a previous comparison of this input. */
  readonly operatorDispositions?: readonly OperatorDispositionRecord[];
  /** Injected so tests never depend on wall-clock ordering. */
  readonly now?: () => string;
};

function nowIso(options: AuthorityComparisonRunOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function failed(
  projectId: string,
  inputSnapshotDigest: string | null,
  failureReason: string,
  createdAt: string,
): FailedAuthorityComparison {
  return {
    comparisonVersion: PROJECT_TRUTH_AUTHORITY_COMPARISON_VERSION,
    projectId,
    inputSnapshotDigest,
    comparisonStatus: 'comparison_failed',
    failureReason,
    createdAt,
  };
}

/**
 * Resolves the comparison status from the two run summaries and the deltas.
 *
 * `equivalent` requires BOTH that no material delta survived and that canonical
 * actually established authority. A canonical run that blocked is reported as
 * `canonical_blocked`, never as equivalent — "we found no differences because one
 * side declined to produce an answer" is not parity, and reporting it as parity is
 * exactly how an unearned promotion would happen.
 */
function resolveComparisonStatus(
  canonical: AuthorityRunSummary,
  materialDeltaCount: number,
): ComparisonStatus {
  if (canonical.assemblyStatus === 'blocked' || canonical.assemblyStatus === 'failed') {
    return 'canonical_blocked';
  }
  return materialDeltaCount > 0 ? 'material_delta' : 'equivalent';
}

function summarizeDispositions(
  dispositions: readonly OperatorDispositionRecord[],
  deltaCount: number,
): OperatorDispositionSummary {
  const byDisposition = new Map<OperatorDispositionRecord['disposition'], number>();
  for (const record of dispositions) {
    byDisposition.set(record.disposition, (byDisposition.get(record.disposition) ?? 0) + 1);
  }
  const recorded = new Set(dispositions.map((record) => record.deltaId)).size;
  return {
    recordedCount: recorded,
    outstandingCount: Math.max(0, deltaCount - recorded),
    byDisposition: [...byDisposition.entries()]
      .map(([disposition, count]) => ({ disposition, count }))
      .sort((left, right) => left.disposition.localeCompare(right.disposition, 'en-US')),
  };
}

/**
 * Runs one legacy-versus-canonical comparison over a single frozen input.
 *
 * Never throws for a comparison-internal fault: a comparator failure is returned
 * as a `comparison_failed` outcome so the caller can record it and continue
 * serving. That is the whole reason this returns a union instead of raising.
 */
export async function runProjectTruthAuthorityComparison(
  projectId: string,
  options: AuthorityComparisonRunOptions = {},
): Promise<AuthorityComparisonOutcome> {
  const createdAt = nowIso(options);

  if (inFlight.has(projectId)) {
    return failed(
      projectId,
      null,
      'comparison_reentered: a comparison for this project is already running',
      createdAt,
    );
  }
  inFlight.add(projectId);

  try {
    const snapshot = options.sourceSnapshot ?? await loadValidatorSourceSnapshot(projectId);
    const inputSnapshotDigest = buildComparisonInputSnapshotDigest(snapshot);

    const legacy = runOneAuthority(snapshot, 'legacy');
    const afterLegacy = buildComparisonInputSnapshotDigest(snapshot);
    if (afterLegacy !== inputSnapshotDigest) {
      return failed(
        projectId,
        inputSnapshotDigest,
        'input_mutation_leak: the legacy authority run mutated the shared frozen input',
        createdAt,
      );
    }

    const canonical = runOneAuthority(snapshot, 'canonical');
    const afterCanonical = buildComparisonInputSnapshotDigest(snapshot);
    if (afterCanonical !== inputSnapshotDigest) {
      return failed(
        projectId,
        inputSnapshotDigest,
        'input_mutation_leak: the canonical authority run mutated the shared frozen input',
        createdAt,
      );
    }

    // Pricing identity is authority-neutral and therefore cross-authority: it can
    // only be assigned once both runs exist. Aligning here — rather than inside each
    // run's normalization — is what lets two legacy observations and one canonical
    // observation of the same contract line share an identity.
    const aligned = alignPricingObservations([
      ...legacy.pricingObservations,
      ...canonical.pricingObservations,
    ]);
    const alignedLegacy: AuthorityRunSummary = {
      ...legacy,
      governingPricing: alignedPricingReferences(aligned, 'legacy'),
    };
    const alignedCanonical: AuthorityRunSummary = {
      ...canonical,
      governingPricing: alignedPricingReferences(aligned, 'canonical'),
    };

    const deltas = buildAuthorityComparisonDeltas(alignedLegacy, alignedCanonical);
    const deltaGroups = buildAuthorityComparisonDeltaGroups(deltas);
    const classificationSummary = summarizeClassifications(deltas);
    const materialDeltaCount = classificationSummary.blockingDeltas
      + classificationSummary.reviewRequiredDeltas;
    const dispositions = [...(options.operatorDispositions ?? [])]
      .sort((left, right) => left.deltaId.localeCompare(right.deltaId, 'en-US'));

    return {
      comparisonVersion: PROJECT_TRUTH_AUTHORITY_COMPARISON_VERSION,
      projectId,
      inputSnapshotDigest,
      legacy: alignedLegacy,
      canonical: alignedCanonical,
      deltas,
      deltaGroups,
      classificationSummary,
      comparisonStatus: resolveComparisonStatus(canonical, materialDeltaCount),
      failureReason: null,
      operatorDispositions: dispositions,
      operatorDispositionSummary: summarizeDispositions(dispositions, deltas.length),
      createdAt,
    };
  } catch (error) {
    return failed(
      projectId,
      null,
      `comparison_failed: ${error instanceof Error ? error.message : String(error)}`,
      createdAt,
    );
  } finally {
    inFlight.delete(projectId);
  }
}

/**
 * Builds and executes one authority run, then normalizes it.
 *
 * The validation outcome is intentionally local to this function. It is normalized
 * and then goes out of scope, so no comparison result can carry a servable
 * validation payload out of this module.
 */
function runOneAuthority(
  snapshot: ValidatorSourceSnapshot,
  authorityMode: 'legacy' | 'canonical',
): AuthorityRunSummary {
  const input = buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode });
  const { result } = executeProjectValidation(input);
  return normalizeAuthorityRun({ authorityMode, input, result });
}

/**
 * The deterministic content digest of a comparison.
 *
 * Excludes `createdAt` and the operator disposition records: wall-clock and later
 * human annotations must not change the identity of the comparison they annotate.
 * Used by the persistence layer for idempotency and by tests for determinism.
 */
export function buildComparisonContentDigest(
  comparison: ProjectTruthAuthorityComparison,
): string {
  return sha256Hex(canonicalJson({
    comparisonVersion: comparison.comparisonVersion,
    projectId: comparison.projectId,
    inputSnapshotDigest: comparison.inputSnapshotDigest,
    legacy: comparison.legacy,
    canonical: comparison.canonical,
    deltas: comparison.deltas,
    classificationSummary: comparison.classificationSummary,
    comparisonStatus: comparison.comparisonStatus,
  }));
}
