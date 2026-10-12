import { z } from 'zod';

import { FAILURE_REGISTRY } from '@/lib/diagnostics/failureRegistry';
import { CONTRACT_RATE_ROW_FACT_KEY } from '@/lib/humanFactAssertions/regionBoundAssertions';
import { attributeExtraction } from '@/lib/improvementAttribution';
import {
  FRICTION_MEASUREMENT_V1,
  improvementProblemFromSignal,
  measureFriction,
  type MeasurementUnit,
} from '@/lib/improvementMeasurement';
import {
  classifyForgewingProducers,
  extractionCorrectionUnits,
  extractionDiagnosticUnits,
  fixDimensionsFor,
  forgewingProposalUnits,
  FRICTION_MEASUREMENT_WINDOWS_V1,
  measurementWindows,
  revisionProducerClassification,
  ruleFindingUnits,
  type ExtractionUnitRow,
} from '@/lib/improvementMeasurementUnits';
import { deriveValueReadingTelemetry } from '@/lib/resolution/valueReadingLifecycle';
import { allowlistDocumentType } from '@/lib/resolution/frictionSignalAllowlist';
import { extractionDocumentDiagnostics } from '@/lib/server/documentDiagnosticsRead';
import { loadRegionBoundAssertionRows, type RegionAssertionClient } from '@/lib/server/regionBoundHumanAssertions';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { loadValueReadingRecords, VALUE_READING_PROPOSAL_TABLE } from '@/lib/server/valueReadingProposals';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

/**
 * B8.4c: measure one deployed fix against its originating friction, and record
 * a person's decision on the result. Trusted server only; platform-review
 * authority, checked at the route and again here.
 *
 * Measurement reads this organization's records with the trusted server's own
 * access, builds units with the shared builders (`lib/improvementMeasurementUnits.ts`),
 * classifies producers only from what the worker proved by git ancestry (and,
 * for Forgewing identities, from when each identity appeared), applies
 * `friction_measurement_v1`, and records an immutable snapshot. The database
 * re-derives the decisive outcomes from the stored counts and appends the
 * lifecycle event. Nothing here closes work: `resolved` is only ever a
 * person's decision on a `resolution_candidate`.
 */

export const RECORD_MEASUREMENT_SNAPSHOT_FUNCTION = 'record_improvement_measurement_snapshot' as const;
export const RECORD_MEASUREMENT_DECISION_FUNCTION = 'record_improvement_measurement_decision' as const;
export const READ_EXTRACTION_UNITS_FUNCTION = 'read_improvement_extraction_units' as const;

/** Upper bounds per read. Reaching one makes the measurement unmeasurable (`read_truncated`), never partial. */
export const MEASUREMENT_READ_LIMITS = Object.freeze({
  findings: 2_000, proposals: 2_000, extractionUnits: 2_000, diagnosticExtractions: 300,
});
const CHUNK = 100;
const DIAGNOSTIC_CHUNK = 10;

type QueryResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
type Query = QueryResult & {
  eq(column: string, value: unknown): Query; in(column: string, values: readonly unknown[]): Query;
  is(column: string, value: null): Query; gte(column: string, value: string): Query; lt(column: string, value: string): Query;
  order(column: string, options?: { ascending?: boolean }): Query; limit(count: number): Query; maybeSingle(): QueryResult;
};
export type MeasurementAdmin = {
  from(table: string): { select(columns: string): Query };
  rpc(name: string, args: Record<string, unknown>): QueryResult;
};

type Reviewer = Readonly<{ actorId: string; email: string | null; role: string | null }>;
type Windows = NonNullable<ReturnType<typeof measurementWindows>>;
type UnitRead = Readonly<{ units: MeasurementUnit[]; readTruncated: boolean; exposureUndefined?: true;
  bounds: Record<string, number | boolean> }>;

function rows(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object') : [];
}
function chunks<T>(values: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}
class ReadFailed extends Error {}
async function read(query: QueryResult): Promise<Record<string, unknown>[]> {
  const { data, error } = await query;
  if (error) throw new ReadFailed(error.code ?? 'read_failed');
  return rows(data);
}
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const inWindows = (at: string, windows: Windows) => at >= windows.baseline.from && at < windows.post.to;

async function organizationScope(admin: MeasurementAdmin, organizationId: string) {
  const projects = await read(admin.from('projects').select('id').eq('organization_id', organizationId));
  const documents = await read(admin.from('documents').select('id, document_type').eq('organization_id', organizationId));
  return {
    projectIds: projects.flatMap((row) => str(row.id) ?? []),
    documents: documents.flatMap((row) => str(row.id) ? [{ id: row.id as string, documentType: str(row.document_type) }] : []),
  };
}

// ---------------------------------------------------------------------------
// Unit readers, one per problem kind.
// ---------------------------------------------------------------------------

async function ruleSemanticsUnits(admin: MeasurementAdmin, organizationId: string, ruleId: string,
  windows: Windows): Promise<UnitRead> {
  const { projectIds } = await organizationScope(admin, organizationId);
  const limit = MEASUREMENT_READ_LIMITS.findings;
  const findings = projectIds.length === 0 ? [] : await read(admin.from('project_validation_findings')
    .select('id, run_id, created_at').eq('rule_id', ruleId).in('project_id', projectIds)
    .gte('created_at', windows.baseline.from).lt('created_at', windows.post.to)
    .order('created_at', { ascending: true }).limit(limit + 1));
  const truncated = findings.length > limit;
  const kept = findings.slice(0, limit).flatMap((row) => str(row.id) && str(row.created_at)
    ? [{ id: row.id as string, run_id: str(row.run_id), created_at: row.created_at as string }] : []);
  const runsById = new Map<string, { id: string } & Record<string, unknown>>();
  for (const ids of chunks([...new Set(kept.flatMap((finding) => finding.run_id ?? []))])) {
    for (const run of await read(admin.from('project_validation_runs')
      .select('id, deployment_revision, deployment_environment, rule_catalogue_fingerprint').in('id', ids))) {
      if (str(run.id)) runsById.set(run.id as string, run as { id: string } & Record<string, unknown>);
    }
  }
  const overridden = new Set<string>();
  for (const ids of chunks(kept.map((finding) => finding.id))) {
    for (const item of await read(admin.from('execution_items').select('source_id')
      .eq('organization_id', organizationId).eq('source_type', 'validator_finding').eq('outcome', 'overridden')
      .in('source_id', ids))) {
      if (str(item.source_id)) overridden.add(item.source_id as string);
    }
  }
  return { units: ruleFindingUnits({ findings: kept, runsById, overriddenFindingIds: overridden }),
    readTruncated: truncated, bounds: { findingsRead: kept.length, findingLimit: limit } };
}

async function forgewingRejectedUnits(admin: MeasurementAdmin, organizationId: string,
  windows: Windows): Promise<UnitRead> {
  const { documents } = await organizationScope(admin, organizationId);
  const documentIds = documents.map((document) => document.id);
  const records = await loadValueReadingRecords(admin as never, { organizationId, documentIds });
  const assertions = await loadRegionBoundAssertionRows(admin as unknown as RegionAssertionClient, documentIds);
  if (assertions.status !== 'ok') throw new ReadFailed('assertions_unavailable');
  const rejected = new Set(deriveValueReadingTelemetry({ ...records, assertions: assertions.rows })
    .flatMap((event) => event.outcome === 'forgewing_rejected' && event.proposalId ? [event.proposalId] : []));
  const limit = MEASUREMENT_READ_LIMITS.proposals;
  const inScope = records.proposals.filter((proposal) => inWindows(new Date(proposal.createdAt).toISOString(), windows));
  const kept = inScope.slice(0, limit);
  const identityByRowId = new Map<string, Record<string, unknown>>();
  for (const ids of chunks(kept.map((proposal) => proposal.rowId))) {
    for (const row of await read(admin.from(VALUE_READING_PROPOSAL_TABLE)
      .select('id, task_type, schema_version, provider_model, prompt_template_id, prompt_template_version')
      .eq('organization_id', organizationId).in('id', ids))) {
      if (str(row.id)) identityByRowId.set(row.id as string, row);
    }
  }
  return { units: forgewingProposalUnits({ proposals: kept, identityByRowId, rejectedProposalIds: rejected }),
    readTruncated: inScope.length > limit, bounds: { proposalsRead: kept.length, proposalLimit: limit } };
}

async function manualCorrectionUnits(admin: MeasurementAdmin, organizationId: string, documentType: string,
  windows: Windows): Promise<UnitRead> {
  const { documents } = await organizationScope(admin, organizationId);
  const documentIds = documents.filter((document) => allowlistDocumentType(document.documentType) === documentType)
    .map((document) => document.id);
  const limit = MEASUREMENT_READ_LIMITS.extractionUnits;
  const extractionRows = documentIds.length === 0 ? [] : await read(admin.rpc(READ_EXTRACTION_UNITS_FUNCTION, {
    p_organization_id: organizationId, p_document_ids: documentIds, p_from: windows.baseline.from,
    p_to: windows.post.to, p_limit: limit }));
  const extractions: ExtractionUnitRow[] = extractionRows.slice(0, limit).flatMap((row) =>
    str(row.extraction_id) && str(row.document_id) && str(row.created_at) ? [{
      extraction_id: row.extraction_id as string, document_id: row.document_id as string,
      created_at: row.created_at as string, deployment_revision: str(row.deployment_revision),
      deployment_environment: str(row.deployment_environment),
      mapping_revisions: Array.isArray(row.mapping_revisions) ? row.mapping_revisions.filter((v): v is string => typeof v === 'string') : [],
    }] : []);
  // The friction report's manual correction: an active, operator-entered,
  // region-bound reviewed rate row. Provenance columns are read separately so
  // the shared reviewed-value select never depends on them.
  const corrected = new Set<string>();
  const unproven = new Set<string>();
  for (const ids of chunks(documentIds)) {
    for (const row of await read(admin.from('human_fact_assertions')
      .select('id, source_document_id, fact_key, status, review_origin, asserted_at, source_extraction_id')
      .eq('organization_id', organizationId).eq('source_binding', 'region_bound').in('source_document_id', ids))) {
      if (row.status !== 'active' || row.fact_key !== CONTRACT_RATE_ROW_FACT_KEY || row.review_origin !== 'operator_entered'
        || !str(row.asserted_at) || !inWindows(new Date(row.asserted_at as string).toISOString(), windows)) continue;
      if (str(row.source_extraction_id)) corrected.add(row.source_extraction_id as string);
      else if (str(row.source_document_id)) unproven.add(row.source_document_id as string);
    }
  }
  return { units: extractionCorrectionUnits({ extractions, correctedExtractionIds: corrected, unprovenDocumentIds: unproven }),
    readTruncated: extractionRows.length > limit,
    bounds: { extractionsRead: extractions.length, extractionLimit: limit, unprovenDocuments: unproven.size } };
}

async function deterministicFailureUnits(admin: MeasurementAdmin, organizationId: string, code: string,
  windows: Windows): Promise<UnitRead> {
  // Only a registry diagnostic is derived from one extraction alone; any other
  // reason code (validator rule, case kind) has no per-extraction exposure.
  if (!Object.prototype.hasOwnProperty.call(FAILURE_REGISTRY, code)) {
    return { units: [], readTruncated: false, exposureUndefined: true, bounds: { exposureDefined: false } };
  }
  const limit = MEASUREMENT_READ_LIMITS.diagnosticExtractions;
  const listed = await read(admin.from('document_extractions').select('id, document_id, created_at')
    .eq('organization_id', organizationId).is('field_key', null)
    .gte('created_at', windows.baseline.from).lt('created_at', windows.post.to)
    .order('created_at', { ascending: true }).limit(limit + 1));
  const kept = listed.slice(0, limit);
  const extractions: Parameters<typeof extractionDiagnosticUnits>[0]['extractions'][number][] = [];
  // Blobs are read a few at a time and dropped: only codes and identity are kept.
  for (const ids of chunks(kept.flatMap((row) => str(row.id) ?? []), DIAGNOSTIC_CHUNK)) {
    for (const row of await read(admin.from('document_extractions').select('id, document_id, created_at, data')
      .eq('organization_id', organizationId).in('id', ids))) {
      const data = row.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : null;
      if (!str(row.id) || !str(row.document_id) || !str(row.created_at) || !data) continue;
      const codes = new Set(extractionDocumentDiagnostics({ organizationId, sourceDocumentId: row.document_id as string,
        extraction: data, extractionSnapshotId: row.id as string, occurredAt: row.created_at as string })
        .map((diagnostic) => diagnostic.code as string));
      extractions.push({ id: row.id as string, createdAt: row.created_at as string,
        attribution: attributeExtraction(data), diagnosticCodes: codes });
    }
  }
  return { units: extractionDiagnosticUnits({ extractions, code }), readTruncated: listed.length > limit,
    bounds: { extractionsRead: extractions.length, extractionLimit: limit } };
}

// ---------------------------------------------------------------------------
// Measure.
// ---------------------------------------------------------------------------

export const MeasureImprovementInputSchema = z.object({ deployedEventId: z.string().uuid() }).strict();

export type MeasureImprovementResult =
  | Readonly<{ status: 'recorded'; snapshotId: string; outcome: string; reasons: readonly string[];
    lifecycleEventKind: 'measuring' | 'measurement_completed' | null }>
  | Readonly<{ status: 'reviewer_not_eligible' | 'invalid_input' | 'not_configured' | 'deployment_not_found'
    | 'window_not_open' | 'not_measurable_problem' | 'already_completed' | 'read_failed' | 'measurement_failed' }>;

const SnapshotReceiptSchema = z.object({ snapshot_id: z.string().uuid(),
  lifecycle_event_kind: z.enum(['measuring', 'measurement_completed']).nullable() }).strict();

export async function measureImprovement(
  input: unknown,
  reviewer: Reviewer,
  dependencies: Readonly<{ admin?: MeasurementAdmin | null; now?: () => Date }> = {},
): Promise<MeasureImprovementResult> {
  if (!resolveWorkflowPlatformReviewAccess(reviewer).allowed) return { status: 'reviewer_not_eligible' };
  const parsed = MeasureImprovementInputSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid_input' };
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() as unknown as MeasurementAdmin | null : dependencies.admin;
  if (!admin) return { status: 'not_configured' };
  try {
    const [deployed] = await read(admin.from('improvement_lifecycle_events')
      .select('id, organization_id, submission_id, deployment_observed_at')
      .eq('id', parsed.data.deployedEventId).eq('event_kind', 'deployed').limit(1));
    if (!deployed || !str(deployed.organization_id) || !str(deployed.submission_id) || !str(deployed.deployment_observed_at)) {
      return { status: 'deployment_not_found' };
    }
    const organizationId = deployed.organization_id as string;
    const [submission] = await read(admin.from('improvement_signal_submissions')
      .select('id, organization_id, signal_kind, signal_code').eq('id', deployed.submission_id as string).limit(1));
    if (!submission || submission.organization_id !== organizationId) return { status: 'deployment_not_found' };
    const problem = improvementProblemFromSignal(organizationId,
      { signalKind: String(submission.signal_kind), code: String(submission.signal_code) });
    if (!problem) return { status: 'not_measurable_problem' };
    const asOf = (dependencies.now ?? (() => new Date()))().toISOString();
    const windows = measurementWindows(deployed.deployment_observed_at as string, asOf);
    if (!windows) return { status: 'window_not_open' };

    const classifications = await read(admin.from('improvement_producer_classifications')
      .select('producer_revision, contains_fix').eq('deployed_event_id', deployed.id as string));
    const unitRead = problem.signalKind === 'rule_semantics_review'
      ? await ruleSemanticsUnits(admin, organizationId, problem.code, windows)
      : problem.signalKind === 'forgewing_rejected'
        ? await forgewingRejectedUnits(admin, organizationId, windows)
        : problem.signalKind === 'recurring_manual_correction'
          ? await manualCorrectionUnits(admin, organizationId, problem.code, windows)
          : await deterministicFailureUnits(admin, organizationId, problem.code, windows);
    const producerClassification = {
      ...revisionProducerClassification(classifications.flatMap((row) =>
        str(row.producer_revision) && typeof row.contains_fix === 'boolean'
          ? [{ producer_revision: row.producer_revision as string, contains_fix: row.contains_fix as boolean }] : [])),
      ...classifyForgewingProducers(unitRead.units, deployed.deployment_observed_at as string),
    };
    const measured = measureFriction({ problem, windows, producerClassification,
      fixDimensions: fixDimensionsFor(problem.signalKind), readTruncated: unitRead.readTruncated,
      ...(unitRead.exposureUndefined ? { exposureUndefined: true as const } : {}), units: unitRead.units });
    if (!measured.ok) return { status: 'measurement_failed' };
    const measurement = measured.measurement;

    const recorded = await admin.rpc(RECORD_MEASUREMENT_SNAPSHOT_FUNCTION, {
      p_deployed_event_id: deployed.id, p_problem_key: measurement.problemKey,
      p_signal_kind: problem.signalKind, p_signal_code: problem.code,
      p_policy_version: FRICTION_MEASUREMENT_V1.version, p_window_policy_version: FRICTION_MEASUREMENT_WINDOWS_V1.version,
      p_baseline_from: windows.baseline.from, p_baseline_to: windows.baseline.to,
      p_post_from: windows.post.from, p_post_to: windows.post.to,
      p_baseline_exposure: measurement.baseline.exposure, p_baseline_occurrences: measurement.baseline.occurrences,
      p_post_exposure: measurement.post.exposure, p_post_occurrences: measurement.post.occurrences,
      p_outcome: measurement.outcome, p_reasons: [...measurement.reasons],
      p_measurement: { ...measurement, producerClassification, windows },
      p_measurement_digest_sha256: measurement.digest,
      p_read_bounds: { ...unitRead.bounds, readTruncated: unitRead.readTruncated },
      p_measured_by: reviewer.actorId,
    });
    if (recorded.error) {
      return { status: recorded.error.code === 'B8405' ? 'already_completed'
        : recorded.error.code === 'P0002' ? 'deployment_not_found' : 'measurement_failed' };
    }
    const receipt = SnapshotReceiptSchema.safeParse(rows(recorded.data)[0]);
    if (!receipt.success) return { status: 'measurement_failed' };
    return { status: 'recorded', snapshotId: receipt.data.snapshot_id, outcome: measurement.outcome,
      reasons: measurement.reasons, lifecycleEventKind: receipt.data.lifecycle_event_kind };
  } catch (error) {
    return { status: error instanceof ReadFailed ? 'read_failed' : 'measurement_failed' };
  }
}

// ---------------------------------------------------------------------------
// A person's decision.
// ---------------------------------------------------------------------------

export const MEASUREMENT_DECISIONS = ['resolved', 'recurred_confirmed', 'deferred'] as const;
export const MeasurementDecisionInputSchema = z.object({
  snapshotId: z.string().uuid(),
  /** The latest decision version the reviewer saw; 0 when there was none. */
  expectedDecisionVersion: z.number().int().min(0).max(2_147_483_646),
  decision: z.enum(MEASUREMENT_DECISIONS),
  rationale: z.string().trim().min(1).max(4_000),
}).strict();

export type MeasurementDecisionResult =
  | Readonly<{ status: 'decided'; decisionId: string; decisionVersion: number }>
  | Readonly<{ status: 'reviewer_not_eligible' | 'invalid_input' | 'not_configured' | 'snapshot_not_found'
    | 'not_completed_measurement' | 'decision_not_allowed' | 'version_conflict' | 'decision_failed' }>;

const DECISION_ERRORS: Readonly<Record<string, Exclude<MeasurementDecisionResult['status'], 'decided'>>> = {
  P0002: 'snapshot_not_found', B8407: 'not_completed_measurement', B8408: 'decision_not_allowed',
  '40001': 'version_conflict', '22023': 'invalid_input',
};

export async function recordMeasurementDecision(
  input: unknown,
  reviewer: Reviewer,
  dependencies: Readonly<{ admin?: MeasurementAdmin | null }> = {},
): Promise<MeasurementDecisionResult> {
  if (!resolveWorkflowPlatformReviewAccess(reviewer).allowed) return { status: 'reviewer_not_eligible' };
  const parsed = MeasurementDecisionInputSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid_input' };
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() as unknown as MeasurementAdmin | null : dependencies.admin;
  if (!admin) return { status: 'not_configured' };
  try {
    const result = await admin.rpc(RECORD_MEASUREMENT_DECISION_FUNCTION, {
      p_snapshot_id: parsed.data.snapshotId, p_expected_decision_version: parsed.data.expectedDecisionVersion,
      p_decision: parsed.data.decision, p_rationale: parsed.data.rationale, p_reviewer_actor_id: reviewer.actorId,
    });
    if (result.error) return { status: (result.error.code && DECISION_ERRORS[result.error.code]) || 'decision_failed' };
    const row = rows(result.data)[0];
    if (!row || !str(row.decision_id) || typeof row.decision_version !== 'number') return { status: 'decision_failed' };
    return { status: 'decided', decisionId: row.decision_id as string, decisionVersion: row.decision_version };
  } catch {
    return { status: 'decision_failed' };
  }
}
