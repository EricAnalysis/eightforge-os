import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFdeIntakePlan } from '@/lib/projectIntelligence/fdeIntakePlan';
import { canonicalJson, hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { resolveFdePlan } from '@/lib/projectIntelligence/fdeResolvedPlan';

const mocks=vi.hoisted(()=>({actor:vi.fn(),admin:vi.fn(),packet:vi.fn()}));
vi.mock('@/lib/server/getActorContext',()=>({getActorContext:mocks.actor}));
vi.mock('@/lib/server/supabaseAdmin',()=>({getSupabaseAdmin:mocks.admin}));
vi.mock('@/lib/server/workflowAssessmentReviewRead',()=>({readWorkflowReviewPacket:mocks.packet}));

import { readFdePlanApproval, recordFdePlanReview, uploadFdeSupplementalDocument } from '@/lib/server/fdePlanApproval';

const ASSESSMENT='11111111-1111-4111-8111-111111111111';
const SUBMISSION='22222222-2222-4222-8222-222222222222';
const ORG='33333333-3333-4333-8333-333333333333';
const ACTOR='44444444-4444-4444-8444-444444444444';
const SNAPSHOT='55555555-5555-4555-8555-555555555555';
const REVIEW_ID='66666666-6666-4666-8666-666666666666';
const plan=buildFdeIntakePlan({
  assessmentId:ASSESSMENT,assessmentVersion:1,sourceSubmissionId:SUBMISSION,
  intake:{workflowDescription:'Review invoices',successOutcome:'Reviewed invoice'},
  assessment:{schemaVersion:'workflow_assessment_v2',workflowSteps:[{
    stepId:'extract',classification:'EXTRACT',description:'Read invoice',proposedOutput:'Rows',
    requiredInputs:[],unresolvedAssumptions:[],determinismGaps:[]}],documents:[],limitations:[]},
  suppliedFiles:[],answers:[],existingReview:{reviewId:REVIEW_ID,reviewVersion:1,overallDisposition:'accepted'},
})!;

function query(result:unknown){
  const chain={select:vi.fn(),eq:vi.fn(),order:vi.fn(),limit:vi.fn(),maybeSingle:vi.fn(),insert:vi.fn(),single:vi.fn()};
  for(const method of ['select','eq','order','limit','insert'] as const) chain[method].mockReturnValue(chain);
  chain.maybeSingle.mockResolvedValue({data:result,error:null});
  chain.single.mockResolvedValue({data:result,error:null});
  Object.assign(chain,{then:(resolve:(value:unknown)=>void)=>Promise.resolve({data:result,error:null}).then(resolve)});
  return chain;
}
function admin({owned=true,existingSnapshot=true,latestAssessmentId=ASSESSMENT,priorUpload=null,snapshotPlan=plan}: {owned?:boolean;existingSnapshot?:boolean;latestAssessmentId?:string;priorUpload?:unknown;snapshotPlan?:typeof plan}={}) {
  const sources={
    workflow_assessments:query(owned?{id:ASSESSMENT,source_submission_id:SUBMISSION,assessment_version:1,organization_id:ORG}:null),
    fde_plan_supplemental_documents:query(priorUpload),
    fde_plan_snapshots:query(existingSnapshot?{id:SNAPSHOT,plan_canonical_json:canonicalJson(snapshotPlan)}:null),
    fde_plan_reviews:query([]),
  };
  const rpc=vi.fn().mockResolvedValue({data:{review_id:REVIEW_ID,review_version:1,inserted:true},error:null});
  let assessmentReads=0;
  return {from:vi.fn((name:keyof typeof sources)=>{
    if(name==='workflow_assessments' && ++assessmentReads===2) return query({id:latestAssessmentId});
    return sources[name];
  }),rpc,sources};
}

beforeEach(()=>{
  vi.clearAllMocks();
  vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS','a@example.com');
  vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_ROLES','');
  mocks.actor.mockResolvedValue({ok:true,actor:{actorId:ACTOR,organizationId:ORG,email:'a@example.com',role:null,displayName:null}});
  mocks.packet.mockResolvedValue({status:'ok',packet:{fdeIntakePlan:plan,followUpAnswers:[],intake:{workflowDescription:'Review invoices'}}});
});

describe('FDE plan server authorization',()=>{
  it('rejects unauthenticated reads before querying the database',async()=>{
    mocks.actor.mockResolvedValue({ok:false,status:401,error:'Unauthorized'});
    const db=admin();mocks.admin.mockReturnValue(db);
    const response=await readFdePlanApproval(new Request('http://localhost'),ASSESSMENT);
    expect(response.status).toBe(401);
    expect(db.from).not.toHaveBeenCalled();
  });

  it('fails closed on a plan outside the actor organization',async()=>{
    const db=admin({owned:false});mocks.admin.mockReturnValue(db);
    const response=await recordFdePlanReview(new Request('http://localhost'),ASSESSMENT,{
      baseDigest:hashCanonical(plan),expectedReviewVersion:0,disposition:'approved',rationale:'Reviewed',resolutions:[],waivers:[]});
    expect(response.status).toBe(404);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('rejects a stale submitted plan digest before any decision write',async()=>{
    const db=admin();mocks.admin.mockReturnValue(db);
    const response=await recordFdePlanReview(new Request('http://localhost'),ASSESSMENT,{
      baseDigest:'a'.repeat(64),expectedReviewVersion:0,disposition:'approved',rationale:'Reviewed',resolutions:[],waivers:[]});
    expect(response.status).toBe(409);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('rejects review of an older assessment version',async()=>{
    const db=admin({latestAssessmentId:'77777777-7777-4777-8777-777777777777'});mocks.admin.mockReturnValue(db);
    const response=await recordFdePlanReview(new Request('http://localhost'),ASSESSMENT,{
      baseDigest:hashCanonical(plan),expectedReviewVersion:0,disposition:'approved',rationale:'Reviewed',resolutions:[],waivers:[]});
    expect(response.status).toBe(409);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('scopes an upload retry lookup to the actor organization and source submission',async()=>{
    const uploadRequestId='88888888-8888-4888-8888-888888888888';
    const bytes=new TextEncoder().encode('test evidence');
    const requestDigest=hashCanonical({actorId:ACTOR,uploadRequestId,filename:'evidence.txt',
      sourceSha:sha256Hex(bytes),needIds:[]});
    const db=admin({priorUpload:{id:SNAPSHOT,evidence_revision:1,upload_request_digest_sha256:requestDigest}});
    mocks.admin.mockReturnValue(db);
    const body=new FormData();
    body.set('file',new File([bytes],'evidence.txt',{type:'text/plain'}));
    body.set('needIds','[]');body.set('uploadRequestId',uploadRequestId);
    const response=await uploadFdeSupplementalDocument(new Request('http://localhost',{
      method:'POST',body}),ASSESSMENT);
    expect(response.status).toBe(200);
    expect(db.sources.fde_plan_supplemental_documents.eq).toHaveBeenCalledWith('organization_id',ORG);
    expect(db.sources.fde_plan_supplemental_documents.eq).toHaveBeenCalledWith('source_submission_id',SUBMISSION);
  });

  it('records only the exact resolved recommendation for an eligible plan',async()=>{
    expect(resolveFdePlan(plan,[],[]).eligible).toBe(true);
    const db=admin();mocks.admin.mockReturnValue(db);
    const response=await recordFdePlanReview(new Request('http://localhost'),ASSESSMENT,{
      baseDigest:hashCanonical(plan),expectedReviewVersion:0,disposition:'approved',rationale:'Reviewed',resolutions:[],waivers:[]});
    expect(response.status).toBe(201);
    expect(db.rpc).toHaveBeenCalledWith('record_fde_plan_review',expect.objectContaining({
      p_base_snapshot_id:SNAPSHOT,p_base_digest_sha256:hashCanonical(plan),p_actor_id:ACTOR,
      p_disposition:'approved',p_resolved_digest_sha256:resolveFdePlan(plan,[],[]).digest,
    }));
  });

  it('rejects a decision from an organization member who is not an authorized reviewer',async()=>{
    mocks.actor.mockResolvedValue({ok:true,actor:{actorId:ACTOR,organizationId:ORG,email:'member@customer.example',role:'owner',displayName:null}});
    const db=admin();mocks.admin.mockReturnValue(db);
    const response=await recordFdePlanReview(new Request('http://localhost'),ASSESSMENT,{
      baseDigest:hashCanonical(plan),expectedReviewVersion:0,disposition:'approved',rationale:'Reviewed',resolutions:[],waivers:[]});
    expect(response.status).toBe(403);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('fails closed when no reviewer allowlist is configured',async()=>{
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS','');
    const db=admin();mocks.admin.mockReturnValue(db);
    const response=await recordFdePlanReview(new Request('http://localhost'),ASSESSMENT,{
      baseDigest:hashCanonical(plan),expectedReviewVersion:0,disposition:'rejected',rationale:'Reviewed',resolutions:[],waivers:[]});
    expect(response.status).toBe(403);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('never accepts an actor or organization from the request',async()=>{
    const db=admin();mocks.admin.mockReturnValue(db);
    const response=await recordFdePlanReview(new Request('http://localhost'),ASSESSMENT,{
      baseDigest:hashCanonical(plan),expectedReviewVersion:0,disposition:'approved',rationale:'Reviewed',resolutions:[],waivers:[],
      actorId:'99999999-9999-4999-8999-999999999999',organizationId:'99999999-9999-4999-8999-999999999999'});
    expect(response.status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('binds a decision to the history its reviewer saw and reports a changed history',async()=>{
    const db=admin();mocks.admin.mockReturnValue(db);
    db.rpc.mockResolvedValueOnce({data:null,error:{code:'40001',message:'FDE decision history changed'}} as never);
    const response=await recordFdePlanReview(new Request('http://localhost'),ASSESSMENT,{
      baseDigest:hashCanonical(plan),expectedReviewVersion:0,disposition:'approved',rationale:'Reviewed',resolutions:[],waivers:[]});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({error:'decision_history_changed'});
    expect(db.rpc).toHaveBeenCalledWith('record_fde_plan_review',expect.objectContaining({p_expected_review_version:0}));
  });

  it('does not state a current status when a replay returns an earlier receipt',async()=>{
    const db=admin();mocks.admin.mockReturnValue(db);
    db.rpc.mockResolvedValueOnce({data:{review_id:REVIEW_ID,review_version:1,inserted:false},error:null});
    const response=await recordFdePlanReview(new Request('http://localhost'),ASSESSMENT,{
      baseDigest:hashCanonical(plan),expectedReviewVersion:0,disposition:'approved',rationale:'Reviewed',resolutions:[],waivers:[]});
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('currentStatus');
  });

  it('keeps a failed late file pinned and visible without evidence value or a permanent block',async()=>{
    const failedRow={id:SNAPSHOT,evidence_revision:1,status:'failed',content_sha256:'a'.repeat(64),representation_digest_sha256:null,
      context_digest_sha256:null,context:null,need_ids:[],original_filename:'scan.pdf',uploaded_at:'2026-11-05T00:00:00Z',error:'No readable content'};
    mocks.packet.mockImplementation(async(_id:string,_org:string,supplemental:{files:unknown[];unavailable:boolean;evidenceRevision:number;documents:unknown[]})=>{
      expect(supplemental).toMatchObject({files:[],unavailable:false,evidenceRevision:1});
      expect(supplemental.documents).toHaveLength(1);
      return {status:'ok',packet:{fdeIntakePlan:plan,followUpAnswers:[],intake:{}}};
    });
    const db=admin({priorUpload:[failedRow]});mocks.admin.mockReturnValue(db);
    const response=await recordFdePlanReview(new Request('http://localhost'),ASSESSMENT,{
      baseDigest:hashCanonical(plan),expectedReviewVersion:0,disposition:'approved',rationale:'Reviewed',resolutions:[],waivers:[]});
    expect(response.status).toBe(201);
    expect(db.rpc).toHaveBeenCalledOnce();
  });

  it('still blocks approval when a processed late document fails its identity check',async()=>{
    const brokenRow={id:SNAPSHOT,evidence_revision:1,status:'processed',content_sha256:'a'.repeat(64),representation_digest_sha256:'b'.repeat(64),
      context_digest_sha256:'c'.repeat(64),context:{not:'valid'},need_ids:[],original_filename:'late.csv',uploaded_at:'2026-11-05T00:00:00Z',error:null};
    const db=admin({priorUpload:[brokenRow]});mocks.admin.mockReturnValue(db);
    const response=await recordFdePlanReview(new Request('http://localhost'),ASSESSMENT,{
      baseDigest:hashCanonical(plan),expectedReviewVersion:0,disposition:'approved',rationale:'Reviewed',resolutions:[],waivers:[]});
    expect(response.status).toBe(409);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
