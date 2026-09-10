import { z } from 'zod';

import { canonicalJson } from '@/lib/extraction/domain/hash';
import {
  RepositoryAwareImplementationPlanV2Schema,
  RepositoryPlanRawProviderEvidenceSchema,
  type RepositoryAwareImplementationPlanV2Artifact,
  type RepositoryPlanRawProviderEvidenceArtifact,
} from '@/lib/repositoryAwareImplementationPlan';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const WORKFLOW_REPOSITORY_PLAN_V2_WRITE_FUNCTION =
  'record_workflow_repository_plan_v2_run' as const;

type RpcClient = Readonly<{
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{
    data: unknown;
    error: { message?: string; code?: string } | null;
  }>;
}>;

const receiptSchema = z.object({
  plan_v2_run_id: z.string().uuid(),
  raw_evidence_id: z.string().uuid().nullable(),
  inserted: z.boolean(),
}).strict();

export type RecordWorkflowRepositoryPlanV2Result =
  | Readonly<{ status: 'recorded'; planV2RunId: string; rawEvidenceId: string | null; inserted: boolean }>
  | Readonly<{ status: 'not_configured' | 'invalid_artifact' | 'identity_mismatch' | 'persist_failed' }>;

function withoutDigest(value: { digest: unknown } & Record<string, unknown>): Record<string, unknown> {
  const { digest: _digest, ...envelope } = value;
  return envelope;
}

/**
 * Atomically records one validated Plan V2 and its separate raw provider evidence.
 * The canonical strings are derived here from schema-validated artifacts; callers
 * cannot provide alternate bytes for the database to bless.
 */
export async function recordWorkflowRepositoryPlanV2(
  planV2: RepositoryAwareImplementationPlanV2Artifact,
  rawProviderEvidence: RepositoryPlanRawProviderEvidenceArtifact | null,
  dependencies: Readonly<{ admin?: RpcClient }> = {},
): Promise<RecordWorkflowRepositoryPlanV2Result> {
  const parsedPlan = RepositoryAwareImplementationPlanV2Schema.safeParse(planV2);
  const parsedRaw = rawProviderEvidence === null
    ? null : RepositoryPlanRawProviderEvidenceSchema.safeParse(rawProviderEvidence);
  if (!parsedPlan.success || (parsedRaw !== null && !parsedRaw.success)) return { status: 'invalid_artifact' };

  const expectsRaw = parsedPlan.data.providerProvenance.callCount === 1;
  if (expectsRaw !== (parsedRaw !== null)
    || (parsedRaw && (parsedRaw.data.rawOutputSha256 !== parsedPlan.data.rawOutputSha256
      || parsedRaw.data.sourceGuidanceInputDigestSha256 !== parsedPlan.data.source.guidanceInputDigestSha256))) {
    return { status: 'identity_mismatch' };
  }

  const admin = dependencies.admin ?? getSupabaseAdmin();
  if (!admin) return { status: 'not_configured' };
  try {
    const rawArtifact = parsedRaw?.data ?? null;
    const result = await admin.rpc(WORKFLOW_REPOSITORY_PLAN_V2_WRITE_FUNCTION, {
      p_raw_artifact_canonical_json: rawArtifact === null ? null : canonicalJson(rawArtifact),
      p_raw_envelope_canonical_json: rawArtifact === null ? null : canonicalJson(withoutDigest(rawArtifact)),
      p_plan_v2_canonical_json: canonicalJson(parsedPlan.data),
      p_plan_v2_envelope_canonical_json: canonicalJson(withoutDigest(parsedPlan.data)),
    });
    if (result.error) return { status: 'persist_failed' };
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    const receipt = receiptSchema.safeParse(row);
    if (!receipt.success || expectsRaw !== (receipt.data.raw_evidence_id !== null)) {
      return { status: 'persist_failed' };
    }
    return { status: 'recorded', planV2RunId: receipt.data.plan_v2_run_id,
      rawEvidenceId: receipt.data.raw_evidence_id, inserted: receipt.data.inserted };
  } catch {
    return { status: 'persist_failed' };
  }
}
