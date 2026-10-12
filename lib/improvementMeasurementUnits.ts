import {
  attributeDeploymentIdentity,
  attributeForgewingProposal,
  attributeValidatorFindingCorrection,
  MEASUREMENT_CONFIGURATION_DIMENSIONS,
  mappingRevisionsConfiguration,
  ruleCatalogueConfiguration,
  type UnitAttribution,
} from '@/lib/improvementAttribution';
import { measurementProducerKey, type MeasurementUnit } from '@/lib/improvementMeasurement';

/**
 * B8.4c: measurement units per problem kind, from rows already read. Pure.
 *
 * A unit is one opportunity for the problem to occur, observed when its
 * producer made it, and attributed to that producer only from what was
 * recorded at the time (`lib/improvementAttribution.ts`). Occurrence follows
 * the friction report's own definition of the signal, so measurement and
 * signal never disagree on what counts:
 *
 * - rule_semantics_review (code = rule id): every finding the rule raised;
 *   occurred = an operator overrode it. Producer = the run that raised it.
 * - forgewing_rejected: every value-reading proposal; occurred = the shared
 *   value-reading telemetry records it rejected. Producer = its
 *   provider/model/prompt identity.
 * - recurring_manual_correction (code = allowlisted document type): every
 *   extraction of a document of that type; occurred = an operator-entered
 *   reviewed rate row pinned to that exact extraction. A correction on the
 *   document that names no source extraction makes that document's units
 *   unattributable rather than guessed.
 * - recurring_deterministic_failure (code = diagnostic code): every
 *   extraction; occurred = the shared extraction diagnostics builder derives
 *   that code from it. Other reason codes have no defined exposure.
 */

export const FRICTION_MEASUREMENT_WINDOWS_V1 = Object.freeze({
  version: 'friction_measurement_windows_v1' as const,
  /** Baseline: this many days before the proven deployment observation. */
  baselineDays: 90,
});

const DAY_MS = 86_400_000;

/** Baseline [deployed - 90d, deployed), post [deployed, asOf). Null until asOf is after deployment. */
export function measurementWindows(deploymentObservedAt: string, asOf: string):
  Readonly<{ baseline: { from: string; to: string }; post: { from: string; to: string } }> | null {
  const deployed = Date.parse(deploymentObservedAt);
  const now = Date.parse(asOf);
  if (!Number.isFinite(deployed) || !Number.isFinite(now) || now <= deployed) return null;
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    baseline: { from: iso(deployed - FRICTION_MEASUREMENT_WINDOWS_V1.baselineDays * DAY_MS), to: iso(deployed) },
    post: { from: iso(deployed), to: iso(now) },
  };
}

const instant = (value: string) => new Date(value).toISOString();

export function ruleFindingUnits(input: Readonly<{
  findings: readonly Readonly<{ id: string; run_id: string | null; created_at: string }>[];
  runsById: ReadonlyMap<string, Readonly<{ id: string }> & Record<string, unknown>>;
  overriddenFindingIds: ReadonlySet<string>;
}>): MeasurementUnit[] {
  return input.findings.map((finding) => {
    const run = finding.run_id ? input.runsById.get(finding.run_id) ?? null : null;
    return {
      unitRef: `validation_finding:${finding.id}`,
      observedAt: instant(finding.created_at),
      attribution: attributeValidatorFindingCorrection({ finding, run }),
      configuration: { [MEASUREMENT_CONFIGURATION_DIMENSIONS.ruleCatalogue]: ruleCatalogueConfiguration(run) },
      occurred: input.overriddenFindingIds.has(finding.id),
    };
  });
}

export function forgewingProposalUnits(input: Readonly<{
  proposals: readonly Readonly<{ rowId: string; proposalId: string; createdAt: string }>[];
  identityByRowId: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  rejectedProposalIds: ReadonlySet<string>;
}>): MeasurementUnit[] {
  return input.proposals.map((proposal) => {
    const identity = input.identityByRowId.get(proposal.rowId);
    const attribution: UnitAttribution = identity ? attributeForgewingProposal(identity)
      : { status: 'unattributed', reason: 'producer_not_recorded' };
    return { unitRef: `forgewing_proposal:${proposal.proposalId}`, observedAt: instant(proposal.createdAt),
      attribution, configuration: {}, occurred: input.rejectedProposalIds.has(proposal.proposalId) };
  });
}

export type ExtractionUnitRow = Readonly<{
  extraction_id: string;
  document_id: string;
  created_at: string;
  deployment_revision: string | null;
  deployment_environment: string | null;
  mapping_revisions: readonly string[] | null;
}>;

export function extractionCorrectionUnits(input: Readonly<{
  extractions: readonly ExtractionUnitRow[];
  correctedExtractionIds: ReadonlySet<string>;
  /** Documents with a correction in the windows whose source extraction is unproven. */
  unprovenDocumentIds: ReadonlySet<string>;
}>): MeasurementUnit[] {
  return input.extractions.map((row) => ({
    unitRef: `document_extraction:${row.extraction_id}`,
    observedAt: instant(row.created_at),
    attribution: input.unprovenDocumentIds.has(row.document_id)
      ? { status: 'unattributed', reason: 'historical_source_unproven' }
      : attributeDeploymentIdentity(row),
    configuration: { [MEASUREMENT_CONFIGURATION_DIMENSIONS.customerMapping]:
      mappingRevisionsConfiguration(row.mapping_revisions ?? []) },
    occurred: input.correctedExtractionIds.has(row.extraction_id),
  }));
}

export function extractionDiagnosticUnits(input: Readonly<{
  extractions: readonly Readonly<{ id: string; createdAt: string; attribution: UnitAttribution;
    diagnosticCodes: ReadonlySet<string> }>[];
  code: string;
}>): MeasurementUnit[] {
  return input.extractions.map((row) => ({
    unitRef: `document_extraction:${row.id}`, observedAt: instant(row.createdAt), attribution: row.attribution,
    configuration: {}, occurred: row.diagnosticCodes.has(input.code),
  }));
}

/**
 * Forgewing producers cannot be proven by git ancestry. A provider/model/prompt
 * identity seen only before the deployment lacks the fix; one first seen only
 * after it contains the fix; one seen on both sides did not change with the
 * fix and stays unclassified, so its units are excluded, never assigned.
 */
export function classifyForgewingProducers(units: readonly MeasurementUnit[], deploymentObservedAt: string):
  Record<string, 'contains_fix' | 'lacks_fix'> {
  const deployed = Date.parse(deploymentObservedAt);
  const sides = new Map<string, Set<'before' | 'after'>>();
  for (const unit of units) {
    if (unit.attribution.status !== 'attributed' || unit.attribution.producer.kind !== 'forgewing_request') continue;
    const key = measurementProducerKey(unit.attribution.producer);
    const seen = sides.get(key) ?? new Set();
    seen.add(Date.parse(unit.observedAt) < deployed ? 'before' : 'after');
    sides.set(key, seen);
  }
  const classification: Record<string, 'contains_fix' | 'lacks_fix'> = {};
  for (const [key, seen] of [...sides.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (seen.size === 1) classification[key] = seen.has('before') ? 'lacks_fix' : 'contains_fix';
  }
  return classification;
}

/** Deployment revisions proven by the worker for this deployed fix. */
export function revisionProducerClassification(rows: readonly Readonly<{ producer_revision: string; contains_fix: boolean }>[]):
  Record<string, 'contains_fix' | 'lacks_fix'> {
  return Object.fromEntries([...rows].sort((a, b) => a.producer_revision.localeCompare(b.producer_revision))
    .map((row) => [`revision:${row.producer_revision}`, row.contains_fix ? 'contains_fix' : 'lacks_fix']));
}

/** Configuration dimensions the fix itself is expected to change. */
export function fixDimensionsFor(signalKind: string): string[] {
  // A rule semantics fix changes the rule catalogue by design.
  return signalKind === 'rule_semantics_review' ? [MEASUREMENT_CONFIGURATION_DIMENSIONS.ruleCatalogue] : [];
}
