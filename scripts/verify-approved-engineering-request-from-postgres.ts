import { execFileSync } from 'node:child_process';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import type { RepositoryAwareImplementationPlanV2Artifact } from '@/lib/repositoryAwareImplementationPlan';
import { readApprovedEngineeringRequest } from '@/lib/server/approvedEngineeringRequestRead';
import { recordWorkflowEngineeringReview } from '@/lib/server/workflowEngineeringReview';
import { recordWorkflowRepositoryPlanV2 } from '@/lib/server/workflowRepositoryPlanPersistence';

const databaseUrl: string = (() => {
  const value=process.env.PHASE11E_B3_DATABASE_URL;
  if(!value) throw new Error('PHASE11E_B3_DATABASE_URL is required');
  return value;
})();

function runSql(statement: string): unknown {
  const common = ['-X','-v','ON_ERROR_STOP=1','-At','--dbname',databaseUrl];
  const output = process.platform === 'win32'
    ? execFileSync('wsl.exe',['-u','root','-e','/usr/sbin/runuser','-u','postgres','--','/usr/bin/psql',...common],
      { input: statement, encoding: 'utf8' })
    : execFileSync('psql',common,{ input: statement, encoding: 'utf8' });
  const text = output.trim();
  return text.length === 0 ? null : JSON.parse(text.split(/\r?\n/).at(-1)!);
}

const literal = (value: unknown): string => value === null ? 'NULL'
  : `'${String(value).replaceAll("'","''")}'`;
const jsonb = (value: unknown): string => value === null ? 'NULL' : `${literal(JSON.stringify(value))}::jsonb`;

const admin = {
  async rpc(name: string,args: Record<string,unknown>) {
    try {
      if (name === 'record_workflow_repository_plan_v2_run') {
        const row = runSql(`SELECT row_to_json(result) FROM public.${name}(
          ${literal(args.p_raw_artifact_canonical_json)},${literal(args.p_raw_envelope_canonical_json)},
          ${literal(args.p_plan_v2_canonical_json)},${literal(args.p_plan_v2_envelope_canonical_json)}) AS result;`);
        return {data:row,error:null};
      }
      if (name === 'record_workflow_repository_plan_recommendation_review') {
        const row = runSql(`SET ROLE service_role; SET request.jwt.claim.role='service_role';
          SELECT row_to_json(result) FROM public.${name}(
          ${literal(args.p_plan_v2_run_id)}::uuid,${literal(args.p_plan_v2_digest_sha256)},
          ${literal(args.p_recommendation_id)},${literal(args.p_reviewer_actor_id)}::uuid,
          ${literal(args.p_disposition)},${literal(args.p_capability_scope)},${literal(args.p_reviewer_rationale)},
          ${jsonb(args.p_modified_scope)},${literal(args.p_review_request_digest_sha256)}) AS result;`);
        return {data:row,error:null};
      }
      throw new Error(`unexpected RPC ${name}`);
    } catch (error) { return {data:null,error:{message:error instanceof Error?error.message:'database error'}}; }
  },
  from(table: string) {
    if (!['workflow_repository_plan_v2_runs','workflow_repository_plan_recommendation_reviews'].includes(table))
      throw new Error(`unexpected table ${table}`);
    return { select(columns: string) {
      if (!/^(?:\*|[a-z0-9_, ]+)$/.test(columns)) throw new Error('unsafe verifier columns');
      const filters: Array<[string,unknown]> = [];
      const chain = { eq(column: string,value: unknown) {
        if (!/^[a-z0-9_]+$/.test(column)) throw new Error('unsafe verifier column');
        filters.push([column,value]); return chain;
      }, async maybeSingle() {
        try {
          const where=filters.map(([column,value])=>`${column}=${literal(value)}`).join(' AND ');
          return {data:runSql(`SELECT row_to_json(result) FROM (SELECT ${columns} FROM public.${table}
            WHERE ${where}) AS result;`),error:null};
        } catch(error) { return {data:null,error}; }
      } }; return chain;
    } };
  },
};

const planV1Digest='1'.repeat(64), inputDigest='2'.repeat(64), commitSha='d'.repeat(40);
const evidenceRef=`ev_${'e'.repeat(64)}`;
// Fixture-local reproduction of the persisted recommendation identity contract;
// qualification must not consume the internal B1/B2 guidance implementation.
const recommendationId=`rec_${hashCanonical({domain:'eightforge.repository-plan-recommendation',schemaVersion:1,
  inputDigest:planV1Digest,classification:'RULE',stepId:'qualification-step',
  recommendationKind:'reuse_existing_rule'})}`;
const originalScope={capabilitySummary:'Database-qualified rule seam',summary:'Use the exact database-qualified rule seam.',
  evidenceRefs:[evidenceRef],architectureRisks:[],regressionGates:[{gate:'typecheck' as const}],
  stopConditions:[],unresolvedQuestions:[]};

function buildPlan(): RepositoryAwareImplementationPlanV2Artifact {
  const guidanceEnvelope={domain:'eightforge.repository-plan-guidance' as const,schemaVersion:1 as const,
    stage:'provider_output_validated' as const,authority:'non_authoritative' as const,executable:false as const,
    grantsExecutionAuthority:false as const,requiresHumanReview:true as const,
    sourceGuidanceInputDigestSha256:inputDigest,sourceImplementationPlanV1DigestSha256:planV1Digest,
    classification:'RULE' as const,recommendations:[{stepId:'qualification-step',
      recommendationKind:'reuse_existing_rule' as const,recommendationId,...originalScope,
      existingSeamEvaluation:'existing_seam_cited' as const}],operatorDecisionSuggestions:[],
    unresolvedGlobalQuestions:[],insufficientEvidence:[]};
  const guidance={...guidanceEnvelope,digest:{algorithm:'sha256' as const,
    encoding:'recursive-key-sorted-json-v1' as const,value:hashCanonical(guidanceEnvelope)}};
  const providerProvenance={provider:'anthropic' as const,model:'no-provider-qualification-fixture',
    promptId:'forgewing-repository-plan-guidance' as const,promptVersion:'v1' as const,promptSha256:'3'.repeat(64),
    schemaVersion:'repository-plan-guidance-output-v1' as const,timeoutMs:60000,maxOutputTokens:8000,
    callCount:0 as const,temperature:0 as const,maxRetries:0 as const,repositoryCommitSha:commitSha,
    foundationDigestSha256:'4'.repeat(64),contentBundleDigestSha256:'5'.repeat(64),
    guidanceInputDigestSha256:inputDigest,rawOutputSha256:null,validatedOutputSha256:guidance.digest.value};
  const envelope={domain:'eightforge.repository-aware-implementation-plan' as const,schemaVersion:2 as const,
    authority:'non_authoritative' as const,executable:false as const,grantsExecutionAuthority:false as const,
    requiresHumanReview:true as const,source:{implementationPlanV1DigestSha256:planV1Digest,
      effectiveReviewedSpecificationDigestSha256:'6'.repeat(64),foundationDigestSha256:'4'.repeat(64),
      contentBundleDigestSha256:'5'.repeat(64),guidanceInputDigestSha256:inputDigest,
      reviewPin:{assessmentId:'98000000-0000-4000-8000-000000000001',assessmentVersion:1,
        reviewId:'98000000-0000-4000-8000-000000000002',reviewVersion:1},
      repositorySnapshot:{repositoryUrl:'https://github.com/example/eightforge',objectFormat:'sha1' as const,
        commitSha,branchName:'main',worktreeDirty:false as const,untrackedPolicy:'excluded_from_trusted_manifest' as const,
        submoduleStatus:{state:'none' as const}}},guidance,providerProvenance,rawOutputSha256:null,
    validatedOutputSha256:guidance.digest.value};
  return JSON.parse(canonicalJson({...envelope,digest:{algorithm:'sha256',
    encoding:'recursive-key-sorted-json-v1',value:hashCanonical(envelope)}}));
}

const reviewerId='96000000-0000-4000-8000-000000000001';
process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS='phase11e-b3-reviewer@example.invalid';
const actor={id:reviewerId,email:'phase11e-b3-reviewer@example.invalid',role:'member'};
const plan=buildPlan();
const persisted=await recordWorkflowRepositoryPlanV2(plan,null,{admin});
if(persisted.status!=='recorded') throw new Error(`Plan V2 persistence failed: ${persisted.status}`);

for(const [index,disposition] of ['accepted','modified','rejected','deferred'].entries()) {
  const input={planV2RunId:persisted.planV2RunId,planV2DigestSha256:plan.digest.value,recommendationId,
    disposition,reviewerRationale:`${disposition} through real PostgreSQL.`,
    ...(disposition==='accepted'||disposition==='modified'?{capabilityScope:'workflow_specific'}:{}),
    ...(disposition==='modified'?{modifiedScope:{...originalScope,capabilitySummary:'Exact human replacement',
      summary:'Use the exact human-reviewed replacement.'}}:{})};
  const recorded=await recordWorkflowEngineeringReview(input,actor,{admin});
  if(!recorded.ok) throw new Error(`${disposition} review failed: ${recorded.code}`);
  const result=await readApprovedEngineeringRequest({planV2RunId:persisted.planV2RunId,
    planV2DigestSha256:plan.digest.value,recommendationId,reviewId:recorded.review.reviewId,
    reviewVersion:recorded.review.reviewVersion},{admin});
  if(disposition==='rejected'||disposition==='deferred') {
    if(result.ok||result.code!=='not_approved') throw new Error(`${disposition} unexpectedly derived a request`);
  } else {
    if(!result.ok) throw new Error(`${disposition} request derivation failed: ${result.code}`);
    const request=result.request;
    if(request.authorizes!=='backlog_projection'||request.executable||request.grantsExecutionAuthority
      ||request.authorizesCodeExecution||request.authorizesRepositoryWrites||request.authorizesMigrations
      ||request.authorizesDeployment||request.authorizesCanonicalFactMutation
      ||request.authorizesWorkflowOperationalDecision) throw new Error('backlog-only authority drift');
    if(disposition==='accepted'&&canonicalJson(request.approvedScope)!==canonicalJson(originalScope))
      throw new Error('accepted scope did not derive from exact recommendation');
    if(disposition==='modified'&&request.approvedScope.capabilitySummary!=='Exact human replacement')
      throw new Error('modified scope did not derive from exact human replacement');
  }
  if(index===3) process.stdout.write('PHASE 11E APPROVED ENGINEERING REQUEST REAL POSTGRESQL DERIVATION: PASS\n');
}
