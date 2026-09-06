import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { buildLinearCapabilityProjection } from '@/lib/linearCapabilityProjection';
import { repositoryContentEvidenceId } from '@/lib/repositoryPlanContent';
import { createLinearClient } from '@/lib/server/linearClient';
import { projectApprovedEngineeringRequestToLinear, withdrawLinearProjection } from '@/lib/server/linearProjectionDelivery';

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
    correlation_id:'44444444-4444-4444-8444-444444444444',claim_token:status==='busy'||status==='existing_projected'?null:'55555555-5555-4555-8555-555555555555',
    claim_status:status,linear_issue_id:status==='existing_projected'?issue.id:null,
    linear_issue_identifier:status==='existing_projected'?issue.identifier:null},error:null}; return {data:null,error:null};})};
  const client={createIssue:vi.fn(async()=>issue),findProjectedIssueByIdempotencyKey:vi.fn(async()=>null as typeof issue|null)};
  const dependencies={admin,configuration:{projectId:'linear-project-id',client},
    readApproved:vi.fn(async()=>({ok:true as const,request:request()})),readPlan:vi.fn(async()=>plan)};
  return {calls,admin,client,dependencies};
}

beforeEach(()=>{process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS='reviewer@example.com';delete process.env.INTERNAL_ORCHESTRATOR_ALLOWED_ROLES;});

describe('manual Linear projection delivery',()=>{
  it('searches before a fresh acquired create and creates once only after a lookup miss',async()=>{const h=harness();
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies)).toMatchObject({status:'projected',issue,recovered:false});
    expect(h.client.findProjectedIssueByIdempotencyKey).toHaveBeenCalledTimes(1);expect(h.client.createIssue).toHaveBeenCalledTimes(1);
    expect(h.client.findProjectedIssueByIdempotencyKey.mock.invocationCallOrder[0]).toBeLessThan(h.client.createIssue.mock.invocationCallOrder[0]!);
    expect(h.calls).toEqual(['claim_linear_projection_delivery','confirm_linear_projection_delivery']);});
  it('confirms a discovered issue without creating for a fresh acquired claim',async()=>{const h=harness();
    h.client.findProjectedIssueByIdempotencyKey.mockResolvedValue(issue);
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies)).toMatchObject({status:'projected',issue,recovered:false});
    expect(h.client.findProjectedIssueByIdempotencyKey).toHaveBeenCalledTimes(1);expect(h.client.createIssue).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['claim_linear_projection_delivery','confirm_linear_projection_delivery']);});
  it('searches first and confirms an issue after crash recovery',async()=>{const h=harness('recovered');
    h.client.findProjectedIssueByIdempotencyKey.mockResolvedValue(issue);
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies)).toMatchObject({status:'projected',recovered:true});
    expect(h.client.findProjectedIssueByIdempotencyKey).toHaveBeenCalledTimes(1);expect(h.client.createIssue).not.toHaveBeenCalled();});
  it('creates only after a recovery search proves no issue exists',async()=>{const h=harness('recovered');
    await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies);
    expect(h.client.createIssue).toHaveBeenCalledTimes(1);
    expect(h.client.findProjectedIssueByIdempotencyKey.mock.invocationCallOrder[0]).toBeLessThan(h.client.createIssue.mock.invocationCallOrder[0]!);});
  it('returns busy or existing without any external write',async()=>{for(const state of ['busy','existing_projected'] as const){const h=harness(state);
    const result=await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies);expect(result.status).toBe(state==='busy'?'in_progress':'projected');
    expect(h.client.createIssue).not.toHaveBeenCalled();expect(h.client.findProjectedIssueByIdempotencyKey).not.toHaveBeenCalled();}});
  it('rejects an acquired claim without an ownership token',async()=>{const h=harness();
    h.admin.rpc.mockResolvedValueOnce({data:{correlation_id:'44444444-4444-4444-8444-444444444444',claim_token:null,
      claim_status:'acquired',linear_issue_id:null,linear_issue_identifier:null},error:null});
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies)).toEqual({status:'claim_failed'});
    expect(h.client.findProjectedIssueByIdempotencyKey).not.toHaveBeenCalled();expect(h.client.createIssue).not.toHaveBeenCalled();});
  it('fails closed on an ambiguous lookup without creating',async()=>{const h=harness();h.client.findProjectedIssueByIdempotencyKey.mockRejectedValue(new Error('linear_projection_ambiguous'));
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies)).toEqual({status:'projection_failed'});
    expect(h.client.createIssue).not.toHaveBeenCalled();expect(h.calls).toEqual(['claim_linear_projection_delivery','fail_linear_projection_delivery']);
    expect(h.admin.rpc).toHaveBeenLastCalledWith('fail_linear_projection_delivery',expect.objectContaining({p_failure_code:'linear_projection_ambiguous'}));});
  it('records a typed lookup failure and does not create',async()=>{const h=harness();h.client.findProjectedIssueByIdempotencyKey.mockRejectedValue(new Error('linear_unavailable'));
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies)).toEqual({status:'projection_failed'});
    expect(h.client.createIssue).not.toHaveBeenCalled();expect(h.calls).toEqual(['claim_linear_projection_delivery','fail_linear_projection_delivery']);
    expect(h.admin.rpc).toHaveBeenLastCalledWith('fail_linear_projection_delivery',expect.objectContaining({p_failure_code:'linear_unavailable'}));});
  it('searches before create on a failed retry and performs no automatic retry',async()=>{const h=harness('recovered');h.client.createIssue.mockRejectedValue(new Error('linear_unavailable'));
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,h.dependencies)).toEqual({status:'projection_failed'});
    expect(h.client.findProjectedIssueByIdempotencyKey).toHaveBeenCalledTimes(1);expect(h.client.createIssue).toHaveBeenCalledTimes(1);
    expect(h.client.findProjectedIssueByIdempotencyKey.mock.invocationCallOrder[0]).toBeLessThan(h.client.createIssue.mock.invocationCallOrder[0]!);
    expect(h.calls).toEqual(['claim_linear_projection_delivery','fail_linear_projection_delivery']);});
  it('fails closed before claim for unauthorized, unconfigured, or forged evidence',async()=>{let h=harness();
    expect((await projectApprovedEngineeringRequestToLinear(input,{email:'other@example.com',role:null},h.dependencies)).status).toBe('reviewer_not_eligible');
    h=harness();expect((await projectApprovedEngineeringRequestToLinear(input,reviewer,{...h.dependencies,configuration:null})).status).toBe('projection_not_configured');
    h=harness();const forged={...input,evidenceBindings:[{...input.evidenceBindings[0]!,blobSha:'8'.repeat(40)}]};
    expect((await projectApprovedEngineeringRequestToLinear(forged,reviewer,h.dependencies)).status).toBe('evidence_invalid');expect(h.admin.rpc).not.toHaveBeenCalled();});
  it('does not mutate approval when Linear fails',async()=>{const h=harness();const approved=request();const before=JSON.stringify(approved);
    h.dependencies.readApproved.mockResolvedValue({ok:true,request:approved});h.client.findProjectedIssueByIdempotencyKey.mockRejectedValue(new Error('linear_unavailable'));
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

describe('manual Linear projection withdrawal',()=>{
  it('re-projects a withdrawn request by confirming the original issue without a duplicate create',async()=>{
    const calls:string[]=[];const confirmations:Record<string,unknown>[]=[];let priorIssue:typeof issue|null=null;let claimCount=0;
    const client={
      createIssue:vi.fn(async()=>{priorIssue=issue;return issue;}),
      findProjectedIssueByIdempotencyKey:vi.fn(async(_key:string)=>priorIssue),
    };
    const admin={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{calls.push(name);
      if(name==='claim_linear_projection_delivery'){claimCount+=1;return {data:{
        correlation_id:claimCount===1?'44444444-4444-4444-8444-444444444444':'66666666-6666-4666-8666-666666666666',
        claim_token:claimCount===1?'55555555-5555-4555-8555-555555555555':'77777777-7777-4777-8777-777777777777',
        claim_status:'acquired',linear_issue_id:null,linear_issue_identifier:null},error:null};}
      if(name==='confirm_linear_projection_delivery'){confirmations.push(args);return {data:null,error:null};}
      if(name==='withdraw_linear_projection_delivery')return {data:null,error:null};
      return {data:null,error:null};
    })};
    const dependencies={admin,configuration:{projectId:'linear-project-id',client},
      readApproved:vi.fn(async()=>({ok:true as const,request:request()})),readPlan:vi.fn(async()=>plan)};
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,dependencies)).toMatchObject({status:'projected',issue});
    expect((await withdrawLinearProjection({correlationId:'44444444-4444-4444-8444-444444444444',engineeringRequestDigestSha256:request().digest.value,rationale:'Re-project the controlled copy.'},reviewer,{admin})).status).toBe('withdrawn');
    expect(await projectApprovedEngineeringRequestToLinear(input,reviewer,dependencies)).toMatchObject({status:'projected',issue});
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    expect(client.findProjectedIssueByIdempotencyKey).toHaveBeenCalledTimes(2);
    const keys=client.findProjectedIssueByIdempotencyKey.mock.calls.map(([key])=>key);
    expect(new Set(keys)).toEqual(new Set([`linear-projection:${request().digest.value}`]));
    expect(confirmations).toEqual([
      expect.objectContaining({p_correlation_id:'44444444-4444-4444-8444-444444444444',p_linear_issue_id:issue.id,p_linear_issue_identifier:issue.identifier}),
      expect.objectContaining({p_correlation_id:'66666666-6666-4666-8666-666666666666',p_linear_issue_id:issue.id,p_linear_issue_identifier:issue.identifier}),
    ]);
    expect(calls).toEqual(['claim_linear_projection_delivery','confirm_linear_projection_delivery','withdraw_linear_projection_delivery','claim_linear_projection_delivery','confirm_linear_projection_delivery']);
  });
  it('marks only the external correlation withdrawn without contacting Linear',async()=>{
    const rpc=vi.fn().mockResolvedValue({data:null,error:null});
    await expect(withdrawLinearProjection({correlationId:'44444444-4444-4444-8444-444444444444',engineeringRequestDigestSha256:'a'.repeat(64),rationale:'Wrong external copy.'},reviewer,{admin:{rpc}})).resolves.toEqual({status:'withdrawn'});
    expect(rpc).toHaveBeenCalledWith('withdraw_linear_projection_delivery',expect.objectContaining({p_withdrawal_rationale:'Wrong external copy.'}));
  });
  it('fails closed for unauthorized or malformed withdrawal requests',async()=>{const rpc=vi.fn();
    expect((await withdrawLinearProjection({},reviewer,{admin:{rpc}})).status).toBe('invalid_input');
    expect((await withdrawLinearProjection({correlationId:'44444444-4444-4444-8444-444444444444',engineeringRequestDigestSha256:'a'.repeat(64),rationale:'x'},{email:'other@example.com',role:null},{admin:{rpc}})).status).toBe('reviewer_not_eligible');expect(rpc).not.toHaveBeenCalled();
  });
});
