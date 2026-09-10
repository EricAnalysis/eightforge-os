import { z } from 'zod';

import { RepositoryAwareImplementationPlanV2Schema,
  type RepositoryAwareImplementationPlanV2Artifact } from '@/lib/repositoryAwareImplementationPlan';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const WorkflowRepositoryPlanV2PinSchema = z.object({
  planV2RunId: z.string().uuid(),
  planV2DigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type WorkflowRepositoryPlanV2Pin = z.infer<typeof WorkflowRepositoryPlanV2PinSchema>;

type QueryResult = { data: unknown; error: unknown };
type ReadClient = Readonly<{ from: (table: string) => {
  select: (columns: string) => {
    eq: (column: string, value: unknown) => any;
  };
} }>;

export type ReadWorkflowRepositoryPlanV2Result =
  | Readonly<{ ok: true; planV2: RepositoryAwareImplementationPlanV2Artifact }>
  | Readonly<{ ok: false; code: 'invalid_pin' | 'not_configured' | 'not_found' | 'read_failed' | 'artifact_invalid' }>;

/** Exact-pin validated read. Raw provider evidence is intentionally unreachable here. */
export async function readWorkflowRepositoryPlanV2(
  pin: unknown,
  dependencies: Readonly<{ admin?: ReadClient }> = {},
): Promise<ReadWorkflowRepositoryPlanV2Result> {
  const parsedPin = WorkflowRepositoryPlanV2PinSchema.safeParse(pin);
  if (!parsedPin.success) return { ok: false, code: 'invalid_pin' };
  const admin = dependencies.admin ?? getSupabaseAdmin();
  if (!admin) return { ok: false, code: 'not_configured' };
  try {
    const query = admin.from('workflow_repository_plan_v2_runs')
      .select('id, plan_v2_digest_sha256, plan_v2_canonical_json')
      .eq('id', parsedPin.data.planV2RunId)
      .eq('plan_v2_digest_sha256', parsedPin.data.planV2DigestSha256);
    const result = await query.maybeSingle() as QueryResult;
    if (result.error) return { ok: false, code: 'read_failed' };
    if (result.data === null || typeof result.data !== 'object') return { ok: false, code: 'not_found' };
    const row = result.data as Record<string, unknown>;
    if (row.id !== parsedPin.data.planV2RunId
      || row.plan_v2_digest_sha256 !== parsedPin.data.planV2DigestSha256
      || typeof row.plan_v2_canonical_json !== 'string') return { ok: false, code: 'artifact_invalid' };
    let value: unknown;
    try { value = JSON.parse(row.plan_v2_canonical_json); }
    catch { return { ok: false, code: 'artifact_invalid' }; }
    const artifact = RepositoryAwareImplementationPlanV2Schema.safeParse(value);
    if (!artifact.success || artifact.data.digest.value !== parsedPin.data.planV2DigestSha256)
      return { ok: false, code: 'artifact_invalid' };
    return { ok: true, planV2: artifact.data };
  } catch {
    return { ok: false, code: 'read_failed' };
  }
}
