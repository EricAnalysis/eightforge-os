import { describe, expect, it } from 'vitest';
import { ModifiedEngineeringScopeSchema, WorkflowEngineeringReviewEvidenceSchema, WorkflowEngineeringReviewInputSchema } from '@/lib/workflowEngineeringReview';

const pin={planV2RunId:'11111111-1111-4111-8111-111111111111',planV2DigestSha256:'a'.repeat(64),recommendationId:`rec_${'b'.repeat(64)}`};
const replacement={capabilitySummary:'Human reviewed scope',summary:'Use the existing exact seam.',evidenceRefs:[`ev_${'c'.repeat(64)}`],architectureRisks:[],regressionGates:[{gate:'typecheck'}],stopConditions:[],unresolvedQuestions:[]};
describe('engineering review contracts',()=>{
 it('requires human capability scope only for accepted or modified reviews',()=>{
  expect(WorkflowEngineeringReviewInputSchema.safeParse({...pin,disposition:'accepted',capabilityScope:'workflow_specific',reviewerRationale:'Reviewed.'}).success).toBe(true);
  expect(WorkflowEngineeringReviewInputSchema.safeParse({...pin,disposition:'accepted',reviewerRationale:'Reviewed.'}).success).toBe(false);
  expect(WorkflowEngineeringReviewInputSchema.safeParse({...pin,disposition:'rejected',capabilityScope:'client_specific',reviewerRationale:'No.'}).success).toBe(false);
 });
 it('makes modified scope strict, bounded, and unable to record operator decisions',()=>{
  expect(ModifiedEngineeringScopeSchema.safeParse(replacement).success).toBe(true);
  expect(ModifiedEngineeringScopeSchema.safeParse({...replacement,operatorDecision:'approved'}).success).toBe(false);
 });
 it('enforces immutable evidence disposition coherence',()=>{
  const base={reviewId:'22222222-2222-4222-8222-222222222222',reviewVersion:1,reviewerActorId:'33333333-3333-4333-8333-333333333333',reviewRequestDigestSha256:'d'.repeat(64),...pin,reviewerRationale:'Reviewed.',repositoryCommitSha:'e'.repeat(40)};
  expect(WorkflowEngineeringReviewEvidenceSchema.safeParse({...base,disposition:'modified',capabilityScope:'reusable_platform_capability',modifiedScope:replacement}).success).toBe(true);
  expect(WorkflowEngineeringReviewEvidenceSchema.safeParse({...base,disposition:'deferred',capabilityScope:null,modifiedScope:null}).success).toBe(true);
  expect(WorkflowEngineeringReviewEvidenceSchema.safeParse({...base,disposition:'deferred',capabilityScope:'workflow_specific',modifiedScope:null}).success).toBe(false);
 });
});
