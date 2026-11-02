import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { PROJECT_CONTEXT_BOUNDS, type OperatorIntent } from '@/lib/projectIntelligence/contextPlan';
import type { ProductImprovementSignal } from '@/lib/projectIntelligence/improvementSignal';
import type { ProjectContextOmissionReason, ProjectIntelligenceContext } from '@/lib/projectIntelligence/projectContext';
import type { operatorGuidanceTelemetry } from '@/lib/projectIntelligence/telemetry';

/**
 * Durable records of project intelligence: what a guidance answer did, and which
 * product signals it observed. Trusted server only.
 *
 * Content-free by construction. A row is built from closed vocabularies, counts,
 * measurements and references, so no question, answer or title can reach it: this
 * module is never handed one. Recording is best effort and never changes the answer
 * it describes.
 *
 * Non-authoritative. These rows are read only by the platform-gated signals route,
 * by no truth, Validator, pricing or configuration path. A review records a person's
 * disposition and does nothing else.
 */

export const GUIDANCE_EVENTS_TABLE = 'project_intelligence_guidance_events';
export const SIGNALS_TABLE = 'project_intelligence_signals';
export const SIGNAL_REVIEWS_TABLE = 'project_intelligence_signal_reviews';

export const SIGNAL_REVIEW_DISPOSITIONS = ['accepted_for_triage', 'rejected', 'deferred'] as const;
export type SignalReviewDisposition = typeof SIGNAL_REVIEW_DISPOSITIONS[number];

const COMMIT = /^[0-9a-f]{7,64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const ATTEMPTED = new Set(['provider_failed', 'rejected', 'accepted']);

type GuidanceTelemetry = ReturnType<typeof operatorGuidanceTelemetry>;

function omitted(context: ProjectIntelligenceContext, reason: ProjectContextOmissionReason) {
  return context.omissions.filter((entry) => entry.reason === reason).map((entry) => entry.kind);
}

const bounded = (value: string | null, max: number) => (value && value.trim().length > 0 ? value.trim().slice(0, max) : null);

/** The exact row written: every field bounded, nothing free-form. Pure. */
export function guidanceEventRow(params: Readonly<{
  id: string;
  context: ProjectIntelligenceContext;
  telemetry: GuidanceTelemetry;
  signals: readonly ProductImprovementSignal[];
  rejection: string | null;
  reservationId: string | null;
  requestContract: string | null;
  runtimeCommit: string | undefined;
}>) {
  const { context, telemetry } = params;
  const attempted = ATTEMPTED.has(telemetry.providerStatus);
  const planned = context.plan.sections;
  return {
    id: params.id,
    organization_id: context.organizationId,
    project_id: context.projectId,
    intent: telemetry.intent,
    intent_basis: telemetry.intentBasis,
    evidence_state: telemetry.evidenceState,
    next_step: telemetry.nextStep,
    confidence: telemetry.confidence,
    sections_planned: [...planned],
    sections_read: [...telemetry.sectionsUsed],
    sections_transmitted: [...telemetry.sectionsTransmitted],
    sections_not_available: omitted(context, 'not_available'),
    sections_read_failed: omitted(context, 'read_failed'),
    sections_not_approved: omitted(context, 'content_class_not_approved'),
    sections_over_budget: omitted(context, 'over_budget'),
    record_count: telemetry.retrievalCount,
    citation_count: telemetry.citationCount,
    provider_status: telemetry.providerStatus,
    model_attempted: attempted,
    answer_source: telemetry.providerStatus === 'accepted' ? 'model_accepted' : attempted ? 'deterministic_fallback' : 'deterministic',
    validation_failure_code: telemetry.providerStatus === 'rejected' ? params.rejection : null,
    model: bounded(telemetry.model, 200),
    input_tokens: telemetry.inputTokens,
    output_tokens: telemetry.outputTokens,
    latency_ms: telemetry.latencyMs,
    stop_reason: bounded(telemetry.stopReason, 64),
    request_contract: attempted ? params.requestContract : null,
    request_digest_sha256: telemetry.requestDigest && DIGEST.test(telemetry.requestDigest) ? telemetry.requestDigest : null,
    reservation_id: params.reservationId,
    context_read_digest_sha256: context.readDigest,
    runtime_commit: params.runtimeCommit && COMMIT.test(params.runtimeCommit) ? params.runtimeCommit : null,
    signal_categories: [...new Set(params.signals.map((signal) => signal.category))],
    signal_codes: [...new Set(params.signals.map((signal) => signal.code))],
  };
}

/** The exact row written for one signal. The same observation always has the same digest. Pure. */
export function signalRow(params: Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  intent: OperatorIntent;
  guidanceEventId: string | null;
  signal: ProductImprovementSignal;
}>) {
  const { signal } = params;
  return {
    id: params.id,
    organization_id: params.organizationId,
    project_id: params.projectId,
    schema_version: signal.schemaVersion,
    authority: signal.authority,
    review_required: signal.reviewRequired,
    category: signal.category,
    signal_code: signal.code,
    orchestrator_root_cause: signal.orchestratorRootCause,
    rule_id: signal.ruleId,
    evidence_state: signal.evidenceState,
    source_intent: params.intent,
    finding_ref: signal.findingRef,
    record_refs: [...signal.recordRefs],
    signal_digest_sha256: hashCanonical({
      projectId: params.projectId, category: signal.category, code: signal.code, ruleId: signal.ruleId,
      evidenceState: signal.evidenceState, findingRef: signal.findingRef, recordRefs: signal.recordRefs,
    }),
    guidance_event_id: params.guidanceEventId,
  };
}

function warnNotRecorded(record: string, code: string | null) {
  // By code only: never a value from the row.
  console.warn('[projectIntelligence] record_not_written', { record, code });
}

/** Best effort: never throws, and the operator's answer does not depend on it. */
export async function recordGuidanceAnswer(
  admin: Pick<SupabaseClient, 'from'>,
  params: Readonly<{
    context: ProjectIntelligenceContext;
    telemetry: GuidanceTelemetry;
    signals: readonly ProductImprovementSignal[];
    rejection: string | null;
    reservationId: string | null;
    requestContract: string;
    newId?: () => string;
  }>,
): Promise<void> {
  const newId = params.newId ?? randomUUID;
  const eventId = newId();
  let eventWritten = false;
  try {
    const { error } = await admin.from(GUIDANCE_EVENTS_TABLE).insert(guidanceEventRow({
      id: eventId, context: params.context, telemetry: params.telemetry, signals: params.signals, rejection: params.rejection,
      reservationId: params.reservationId, requestContract: params.requestContract,
      runtimeCommit: process.env.VERCEL_GIT_COMMIT_SHA,
    }));
    eventWritten = !error;
    if (error) warnNotRecorded('guidance_event', error.code ?? null);
  } catch {
    warnNotRecorded('guidance_event', 'threw');
  }
  const signals = params.signals.slice(0, PROJECT_CONTEXT_BOUNDS.maxFindings);
  if (signals.length === 0) return;
  try {
    const { error } = await admin.from(SIGNALS_TABLE).upsert(signals.map((signal) => signalRow({
      id: newId(), organizationId: params.context.organizationId, projectId: params.context.projectId,
      intent: params.context.plan.intent, guidanceEventId: eventWritten ? eventId : null, signal,
    })), { onConflict: 'organization_id,project_id,signal_digest_sha256', ignoreDuplicates: true });
    if (error) warnNotRecorded('signal', error.code ?? null);
  } catch {
    warnNotRecorded('signal', 'threw');
  }
}

export type StoredProjectSignal = Readonly<{
  id: string;
  projectId: string;
  category: string;
  code: string;
  orchestratorRootCause: string | null;
  ruleId: string;
  evidenceState: string;
  sourceIntent: string;
  findingRef: string;
  recordRefs: readonly string[];
  guidanceEventId: string | null;
  firstObservedAt: string;
  reviewStatus: SignalReviewDisposition | 'unreviewed';
  reviewVersion: number;
}>;

const STORED_SIGNAL_LIMIT = 100;

/** The newest stored signals of one project in one organization, each with its latest review. */
export async function readStoredProjectSignals(
  admin: Pick<SupabaseClient, 'from'>,
  params: Readonly<{ organizationId: string; projectId: string }>,
): Promise<readonly StoredProjectSignal[]> {
  const signals = await admin.from(SIGNALS_TABLE)
    .select('id, project_id, category, signal_code, orchestrator_root_cause, rule_id, evidence_state, source_intent, finding_ref, record_refs, guidance_event_id, first_observed_at')
    .eq('organization_id', params.organizationId).eq('project_id', params.projectId)
    .order('first_observed_at', { ascending: false }).order('id', { ascending: true }).limit(STORED_SIGNAL_LIMIT);
  if (signals.error) throw new Error('Failed to read project intelligence signals.');
  const rows = (signals.data ?? []) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const reviews = await admin.from(SIGNAL_REVIEWS_TABLE)
    .select('signal_id, review_version, disposition')
    .eq('organization_id', params.organizationId).in('signal_id', rows.map((row) => String(row.id)));
  if (reviews.error) throw new Error('Failed to read project intelligence signal reviews.');
  const latest = new Map<string, { version: number; disposition: SignalReviewDisposition }>();
  for (const review of (reviews.data ?? []) as unknown as Array<{ signal_id: string; review_version: number; disposition: SignalReviewDisposition }>) {
    const held = latest.get(review.signal_id);
    if (!held || review.review_version > held.version) latest.set(review.signal_id, { version: review.review_version, disposition: review.disposition });
  }
  return rows.map((row) => {
    const review = latest.get(String(row.id));
    return {
      id: String(row.id), projectId: String(row.project_id), category: String(row.category), code: String(row.signal_code),
      orchestratorRootCause: row.orchestrator_root_cause == null ? null : String(row.orchestrator_root_cause),
      ruleId: String(row.rule_id), evidenceState: String(row.evidence_state), sourceIntent: String(row.source_intent),
      findingRef: String(row.finding_ref), recordRefs: (row.record_refs as string[]) ?? [],
      guidanceEventId: row.guidance_event_id == null ? null : String(row.guidance_event_id),
      firstObservedAt: String(row.first_observed_at),
      reviewStatus: review?.disposition ?? 'unreviewed', reviewVersion: review?.version ?? 0,
    };
  });
}

export type SignalReviewResult =
  | Readonly<{ status: 'recorded'; reviewId: string; reviewVersion: number }>
  | Readonly<{ status: 'signal_not_found' | 'version_conflict' | 'write_failed' }>;

/**
 * Appends a person's disposition as the next version. It writes this one row and
 * nothing else: the signal, truth, rules and configuration are all out of its reach.
 */
export async function recordSignalReview(
  admin: Pick<SupabaseClient, 'from'>,
  params: Readonly<{ organizationId: string; signalId: string; reviewerActorId: string; disposition: SignalReviewDisposition; newId?: () => string }>,
): Promise<SignalReviewResult> {
  const signal = await admin.from(SIGNALS_TABLE).select('id')
    .eq('organization_id', params.organizationId).eq('id', params.signalId).maybeSingle();
  if (signal.error) return { status: 'write_failed' };
  if (!signal.data) return { status: 'signal_not_found' };
  const prior = await admin.from(SIGNAL_REVIEWS_TABLE).select('review_version')
    .eq('organization_id', params.organizationId).eq('signal_id', params.signalId)
    .order('review_version', { ascending: false }).limit(1);
  if (prior.error) return { status: 'write_failed' };
  const reviewVersion = (((prior.data ?? [])[0] as { review_version?: number } | undefined)?.review_version ?? 0) + 1;
  const reviewId = (params.newId ?? randomUUID)();
  const { error } = await admin.from(SIGNAL_REVIEWS_TABLE).insert({
    id: reviewId, signal_id: params.signalId, organization_id: params.organizationId,
    review_version: reviewVersion, disposition: params.disposition, reviewer_actor_id: params.reviewerActorId,
  });
  if (error) return { status: error.code === '23505' ? 'version_conflict' : 'write_failed' };
  return { status: 'recorded', reviewId, reviewVersion };
}
