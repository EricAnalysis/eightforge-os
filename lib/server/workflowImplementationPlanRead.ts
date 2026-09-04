import {
  readEffectiveReviewedSpecification,
  type EffectiveReviewedSpecificationReadResult,
} from '@/lib/server/workflowEffectiveReviewedSpecificationRead';
import {
  buildWorkflowImplementationPlan,
  type WorkflowImplementationPlanArtifact,
} from '@/lib/workflowImplementationPlan';

export type WorkflowImplementationPlanReadResult =
  | Readonly<{ ok: true; artifact: WorkflowImplementationPlanArtifact }>
  | Extract<EffectiveReviewedSpecificationReadResult, { ok: false }>
  | Readonly<{ ok: false; code: 'plan_not_composable' }>;

/** Authorization and immutable evidence belong to the resolver read seam.
 * Keep its artifact in memory and pass it directly to the pure plan builder:
 * the digest identifies that trusted value, never a caller-supplied payload.
 */
export async function readWorkflowImplementationPlan(
  request: Request,
  pin: unknown,
): Promise<WorkflowImplementationPlanReadResult> {
  try {
    const resolved = await readEffectiveReviewedSpecification(request, pin);
    if (!resolved.ok) return resolved;
    const planned = buildWorkflowImplementationPlan(resolved.artifact);
    if (!planned.ok) {
      console.error('[workflowImplementationPlan] trusted artifact not composable');
      return { ok: false, code: 'plan_not_composable' };
    }
    return planned;
  } catch {
    console.error('[workflowImplementationPlan] composition failed');
    return { ok: false, code: 'plan_not_composable' };
  }
}
