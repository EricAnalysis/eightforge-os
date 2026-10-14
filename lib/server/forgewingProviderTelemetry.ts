import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Forgewing S7: durable, content-free telemetry for production provider calls
 * (`forgewing_provider_call_observations`).
 *
 * Identity and measurements only: never a prompt, answer, excerpt, question or
 * rationale. Recording is best effort and never changes the outcome of the
 * call it describes: a telemetry failure is logged and swallowed.
 */

export const FORGEWING_PROVIDER_CALL_OBSERVATIONS_TABLE = 'forgewing_provider_call_observations';

/**
 * Workflows recorded from server seams today. The ledger's CHECK also admits
 * the extraction shadow and recovery task names, so their consumer seam can
 * record later without a migration.
 */
export const PROVIDER_TELEMETRY_WORKFLOWS = [
  'project_ask', 'workflow_assessment', 'case_investigation', 'priced_value_reading',
  'repository_plan_guidance', 'region_classification', 'recovery_candidate_v2',
] as const;
export type ProviderTelemetryWorkflow = typeof PROVIDER_TELEMETRY_WORKFLOWS[number];

export type ProviderCallOutcome =
  | 'succeeded' | 'provider_failed' | 'provider_timeout' | 'output_truncated' | 'output_invalid';

export type ProviderCallObservationInput = Readonly<{
  /** A ledger workflow (CHECK-enforced); server seams use ProviderTelemetryWorkflow. */
  workflow: ProviderTelemetryWorkflow | (string & Record<never, never>);
  organizationId: string | null;
  reservationId?: string | null;
  requestDigestSha256?: string | null;
  model: string;
  returnedModel?: string | null;
  providerRequestId?: string | null;
  outcome: ProviderCallOutcome;
  stopReason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs: number;
}>;

const DIGEST = /^[0-9a-f]{64}$/;
const boundedText = (value: string | null | undefined, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : null;
const count = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** The exact row written: every field bounded, nothing free-form. */
export function forgewingProviderCallObservationRow(input: ProviderCallObservationInput) {
  return {
    workflow: input.workflow,
    organization_id: input.organizationId,
    reservation_id: input.reservationId ?? null,
    request_digest_sha256: input.requestDigestSha256 && DIGEST.test(input.requestDigestSha256)
      ? input.requestDigestSha256 : null,
    model: boundedText(input.model, 200) ?? 'unknown',
    returned_model: boundedText(input.returnedModel, 200),
    provider_request_id: boundedText(input.providerRequestId, 200),
    outcome: input.outcome,
    stop_reason: boundedText(input.stopReason, 64),
    input_tokens: count(input.inputTokens),
    output_tokens: count(input.outputTokens),
    latency_ms: Math.max(0, Math.round(Number.isFinite(input.latencyMs) ? input.latencyMs : 0)),
  };
}

/** Best effort: resolves `false` on any failure and never throws. */
export async function recordForgewingProviderCallObservation(
  admin: Pick<SupabaseClient, 'from'>,
  input: ProviderCallObservationInput,
): Promise<boolean> {
  try {
    const { error } = await admin.from(FORGEWING_PROVIDER_CALL_OBSERVATIONS_TABLE)
      .insert(forgewingProviderCallObservationRow(input));
    if (error) {
      console.warn('[forgewingTelemetry] observation_not_recorded', { workflow: input.workflow, code: error.code ?? null });
      return false;
    }
    return true;
  } catch {
    console.warn('[forgewingTelemetry] observation_not_recorded', { workflow: input.workflow, code: 'threw' });
    return false;
  }
}

/** Maps a provider failure reason to its observation outcome. */
export function providerFailureOutcome(reason: string | null | undefined): ProviderCallOutcome {
  if (reason === 'provider_timeout') return 'provider_timeout';
  if (reason === 'provider_truncated_output') return 'output_truncated';
  return 'provider_failed';
}
