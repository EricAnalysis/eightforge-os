import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { buildLinearCapabilityProjection } from '@/lib/linearCapabilityProjection';
import { repositoryContentEvidenceId } from '@/lib/repositoryPlanContent';
import { createLinearClient } from '@/lib/server/linearClient';
import { projectApprovedEngineeringRequestToLinear } from '@/lib/server/linearProjectionDelivery';

const commit = '3'.repeat(40);
const classification = 'RULE' as const;
const path = 'lib/rules/check.ts';
const blob = '7'.repeat(40);
const evidenceRef = repositoryContentEvidenceId({ commitSha: commit, classification, filePath: path, blobSha: blob });
const reviewer = { email: 'reviewer@example.com', role: null };

function request() {
  const envelope = { domain:'eightforge.approved-engineering-request' as const,schemaVersion:1 as const,
    authorizes:'backlog_projection' as const,executable:false as const,grantsExecutionAuthority:false as const,
    authorizesCodeExecution:false as const,authorizesRepositoryWrites:false as const,authorizesMigrations:false as const,
    authorizesDeployment:false as const,authorizesCanonicalFactMutation:false as const,
    authorizesWorkflowOperationalDecision:false as const,
    source:{planV2RunId:'11111111-1111-4111-8111-111111111111',planV2DigestSha256:'4'.repeat(64),
      recommendationId:`rec_${'5'.repeat(64)}`,reviewId:'22222222-2222-4222-8222-222222222222',reviewVersion:1,
      reviewRequestDigestSha256:'6'.repeat(64),repositoryCommitSha:commit},capabilitySummary:'Reuse rule',
    approvedScope:{capabilitySummary:'Reuse rule',summary:'Use the existing rule seam.',evidenceRefs:[evidenceRef],
      architectureRisks:[],regressionGates:[],stopConditions:[],unresolvedQuestions:[]},
    scopeSource:'forgewing_recommendation' as const,capabilityScope:'workflow_specific' as const,
    reviewer:{actorId:'33333333-3333-4333-8333-333333333333',rationale:'Approved for backlog only.',disposition:'accepted' as const}};
  return {...envelope,digest:{algorithm:'sha256' as const,encoding:'recursive-key-sorted-json-v1' as const,value:hashCanonical(envelope)}};
}
const input = {planV2RunId:'11111111-1111-4111-8111-111111111111',planV2DigestSha256:'4'.repeat(64),
  recommendationId:`rec_${'5'.repeat(64)}`,reviewId:'22222222-2222-4222-8222-222222222222',reviewVersion:1,
  evidenceBindings:[{evidenceRef,filePath:path,blobSha:blob,commitSha:commit}]};
const plan = { ok:true as const, planV2:{ guidance:{classification} } } as never;
const issue = { id:'linear-id', identifier:'EF-123' };

function harness(status:'acquired'|'recovered'|'busy'|'existing_projected'='acquired') {
  const calls:string[]=[];
  const admin={rpc:vi.fn(async(name:string)=>{calls.push(name); if(name==='claim_linear_projection_delivery')return {data:{
    correlation_id:'44444444-4444-4444-8444-444444444444',claim_token:'55555555-5555-4555-8555-555555555555',
    claim_status:status,linear_issue_id:status==='existing_projected'?issue.id:null,
    linear_issue_identifier:status==='existing_projected'?issue.identifier:null},error:null}; return {data:null,error:null};})};
  const client={createIssue:vi.fn(async()=>issue),findProjectedIssueByIdempotencyKey:vi.fn(async()=>issue)};
  const dependencies={admin,configuration:{projectId:'linear-project-id',client},
    readApproved:vi.fn(async()=>({ok:true as const,request:request()})),readPlan:vi.fn(async()=>plan)};
  return {calls,admin,client,dependencies};
}

beforeEach(()=>{process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS='reviewer@example.com';delete process.env.INTERNAL_ORCHESTRATOR_ALLOWED_ROLES;});

describe('manual Linear projection delivery',()=>{
  it('claims, creates once, and confirms without a search on the initial attempt',async()=>{const h=harness();
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies)).toMatchObject({status:'projected',issue,recovered:false});
    expect(h.client.findProjectedIssueByIdempotencyKey).not.toHaveBeenCalled();expect(h.client.createIssue).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['claim_linear_projection_delivery','confirm_linear_projection_delivery']);});
  it('searches first and confirms an issue after crash recovery',async()=>{const h=harness('recovered');
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies)).toMatchObject({status:'projected',recovered:true});
    expect(h.client.findProjectedIssueByIdempotencyKey).toHaveBeenCalledTimes(1);expect(h.client.createIssue).not.toHaveBeenCalled();});
  it('creates only after a recovery search proves no issue exists',async()=>{const h=harness('recovered');h.client.findProjectedIssueByIdempotencyKey.mockResolvedValue(null as never);
    await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies);
    expect(h.client.findProjectedIssueByIdempotencyKey.mock.invocationCallOrder[0]).toBeLessThan(h.client.createIssue.mock.invocationCallOrder[0]!);});
  it('returns busy or existing without any external write',async()=>{for(const state of ['busy','existing_projected'] as const){const h=harness(state);
    const result=await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies);expect(result.status).toBe(state==='busy'?'in_progress':'projected');
    expect(h.client.createIssue).not.toHaveBeenCalled();expect(h.client.findProjectedIssueByIdempotencyKey).not.toHaveBeenCalled();}});
  it('records a typed failure once and performs no automatic retry',async()=>{const h=harness();h.client.createIssue.mockRejectedValue(new Error('linear_unavailable'));
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies)).toEqual({status:'projection_failed'});
    expect(h.client.createIssue).toHaveBeenCalledTimes(1);expect(h.calls).toEqual(['claim_linear_projection_delivery','fail_linear_projection_delivery']);});
  it('fails closed before claim for unauthorized, unconfigured, or forged evidence',async()=>{let h=harness();
    expect((await projectApprovedEngineeringRequestToLinear(input,{email:'other@example.com',role:null},h.dependencies)).status).toBe('reviewer_not_eligible');
    h=harness();expect((await projectApprovedEngineeringRequestToLinear(input,reviewer,{...h.dependencies,configuration:null})).status).toBe('projection_not_configured');
    h=harness();const forged={...input,evidenceBindings:[{...input.evidenceBindings[0]!,blobSha:'8'.repeat(40)}]};
    expect((await projectApprovedEngineeringRequestToLinear(forged,reviewer,h.dependencies)).status).toBe('evidence_invalid');expect(h.admin.rpc).not.toHaveBeenCalled();});
  it('does not mutate approval when Linear fails',async()=>{const h=harness();const approved=request();const before=JSON.stringify(approved);
    h.dependencies.readApproved.mockResolvedValue({ok:true,request:approved});h.client.createIssue.mockRejectedValue(new Error('linear_unavailable'));
    await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies);expect(JSON.stringify(approved)).toBe(before);
    expect(buildLinearCapabilityProjection(approved,input.evidenceBindings).ok).toBe(true);});
});

describe('minimal Linear GraphQL adapter',()=>{
  it('exposes only create and find and sends the configured project id',async()=>{const fetcher=vi.fn(async(_url:string,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));
    return new Response(JSON.stringify(body.query.includes('issueCreate')?{data:{issueCreate:{success:true,issue:{...issue,project:{id:'p'}}}}}:{data:{issueSearch:{nodes:[{...issue,project:{id:'p'}}]}}}));});
    const client=createLinearClient({apiKey:'secret',projectId:'p',teamId:'t',labelIdsByName:{'Client Request':'1','Forgewing Proposed':'2','Approved for backlog':'3','Workflow-specific':'4'},fetcher:fetcher as typeof fetch});
    expect(Object.keys(client).sort()).toEqual(['createIssue','findProjectedIssueByIdempotencyKey']);
    const built=buildLinearCapabilityProjection(request(),input.evidenceBindings);if(!built.ok)throw new Error(built.code);
    await client.createIssue(built.projection);await client.findProjectedIssueByIdempotencyKey(built.projection.idempotencyKey);
    expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls.every(call=>call[0]==='https://api.linear.app/graphql')).toBe(true);});
});
