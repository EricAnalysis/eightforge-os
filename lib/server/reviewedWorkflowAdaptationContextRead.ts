import { buildReviewedWorkflowAdaptationContext } from '@/lib/customerAdaptation/reviewedWorkflowContext';
import { readEffectiveReviewedSpecification } from '@/lib/server/workflowEffectiveReviewedSpecificationRead';

/** Same authenticated platform access and exact immutable pins as Phase 11.
 * This read does not associate a global assessment with a customer organization.
 */
export async function readReviewedWorkflowAdaptationContext(request: Request, pin: unknown) {
  const resolved = await readEffectiveReviewedSpecification(request, pin);
  if (!resolved.ok) return resolved;
  return buildReviewedWorkflowAdaptationContext(resolved.artifact);
}
