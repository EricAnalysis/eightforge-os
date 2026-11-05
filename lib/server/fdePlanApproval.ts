import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson, hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { parseAssessmentSupportingFile } from '@/lib/extraction/assessmentSupportingFile';
import { captureUploadedStorageObjectVersion } from '@/lib/extraction/persistence/sourceArtifactIdentity';
import { parseAssessmentSupportingFileContext } from '@/lib/workflowAssessmentEvidenceContract';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { readWorkflowReviewPacket } from '@/lib/server/workflowAssessmentReviewRead';
import { resolveFdePlan, isFdeWaiverEligibleNeed, isFdeConfirmableNeed, FDE_WAIVER_ACKNOWLEDGMENT_TEXT,
  FDE_WAIVER_ACKNOWLEDGMENT_VERSION, type FdeEvidenceRef } from '@/lib/projectIntelligence/fdeResolvedPlan';
import type { FdeIntakeFile, FdeIntakePlan } from '@/lib/projectIntelligence/fdeIntakePlan';

const UUID = z.string().uuid();
const DIGEST = z.string().regex(/^[a-f0-9]{64}$/);
const SOURCE_REF = z.object({ kind: z.enum(['attachment','follow_up_answer','intake','assessment','assessment_review','capability_catalogue']),
  id: z.string().min(1), digest: DIGEST }).strict();
const RESOLUTION = z.object({ needId: z.string().regex(/^need_[a-f0-9]{64}$/), disposition: z.enum(['confirmed','unresolved']),
  conclusion: z.string().trim().min(1).max(4000), rationale: z.string().trim().min(1).max(4000), sourceRefs: z.array(SOURCE_REF).max(30) }).strict();
const WAIVER = z.object({ needId: z.string().regex(/^need_[a-f0-9]{64}$/), requirement: z.string().trim().min(1).max(2000),
  customerStatement: z.string().trim().min(1).max(4000), reason: z.string().trim().min(1).max(4000),
  acknowledgmentText: z.literal(FDE_WAIVER_ACKNOWLEDGMENT_TEXT), acknowledgmentVersion: z.literal(FDE_WAIVER_ACKNOWLEDGMENT_VERSION),
  acknowledged: z.literal(true), sourceRefs: z.array(SOURCE_REF).max(30) }).strict();
const REVIEW = z.object({ baseSnapshotId: UUID.optional().nullable(), baseDigest: DIGEST,
  expectedReviewVersion: z.number().int().min(0),
  disposition: z.enum(['approved','rejected','changes_requested']), rationale: z.string().trim().min(1).max(4000),
  resolutions: z.array(RESOLUTION).max(100), waivers: z.array(WAIVER).max(100) }).strict();
type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type Actor = Extract<Awaited<ReturnType<typeof getActorContext>>, {ok:true}>['actor'];
type AssessmentScope = {id:string;source_submission_id:string;assessment_version:number;organization_id:string;isCurrentVersion:boolean};
type Authorized = {ok:false;response:Response} | {ok:true;actor:Actor;admin:Admin;assessment:AssessmentScope};
type SupplementalRow = { id:string; organization_id:string; source_submission_id:string; assessment_id:string;
  evidence_revision:number; need_ids:string[]; original_filename:string; media_type:string; byte_size:number;
  content_sha256:string; representation_digest_sha256:string|null; context_digest_sha256:string|null;
  storage_bucket:string; storage_path:string; storage_version:string; status:'processed'|'failed'; error:string|null;
  context:unknown; uploaded_at:string; upload_request_id:string; upload_request_digest_sha256:string };
const error = (code:string,status:number) => Response.json({ok:false,error:code},{status});

async function authorized(req:Request, assessmentId:string):Promise<Authorized> {
  const actor = await getActorContext(req);
  if (!actor.ok) return {ok:false,response:error('unauthorized',actor.status)};
  if (!UUID.safeParse(assessmentId).success) return {ok:false,response:error('invalid_assessment_id',400)};
  const admin = getSupabaseAdmin();
  if (!admin) return {ok:false,response:error('not_configured',503)};
  const {data, error:readError} = await admin.from('workflow_assessments')
    .select('id,source_submission_id,assessment_version,organization_id')
    .eq('id',assessmentId).eq('organization_id',actor.actor.organizationId).maybeSingle();
  if (readError) return {ok:false,response:error('read_failed',500)};
  if (!data) return {ok:false,response:error('plan_not_found',404)};
  const latest=await admin.from('workflow_assessments').select('id')
    .eq('source_submission_id',data.source_submission_id).eq('organization_id',actor.actor.organizationId)
    .order('assessment_version',{ascending:false}).limit(1);
  if(latest.error || !latest.data) return {ok:false,response:error('read_failed',500)};
  const latestRow=Array.isArray(latest.data)?latest.data[0]:latest.data;
  if(!latestRow?.id) return {ok:false,response:error('read_failed',500)};
  return {ok:true,actor:actor.actor,admin,assessment:{...(data as Omit<AssessmentScope,'isCurrentVersion'>),
    isCurrentVersion:latestRow.id===data.id}};
}

function evidenceChoices(plan:FdeIntakePlan) {
  const pins=plan.pinnedInputs;
  const choices:{label:string;ref:FdeEvidenceRef}[]=[];
  const add=(label:string,kind:FdeEvidenceRef['kind'],id:string,value:unknown)=>choices.push({label,ref:{kind,id,digest:hashCanonical(value)}});
  add('Workflow Assessment','assessment',pins.assessmentId,pins.assessmentDigest);
  add('Customer intake','intake',pins.sourceSubmissionId,pins.intakeDigest);
  pins.suppliedFiles.forEach(file=>add(file.filename,'attachment',file.attachmentId,file));
  pins.answers.forEach(answer=>add(`Follow-up answer revision ${answer.revision}`,'follow_up_answer',answer.answerId,answer));
  if(pins.assessmentReview) add('Assessment review','assessment_review',pins.assessmentReview.reviewId,pins.assessmentReview);
  add('Capability catalogue','capability_catalogue',pins.capabilityCatalogue.identity,pins.capabilityCatalogue);
  return choices;
}

async function currentPlan(admin:Admin,actor:Actor,assessment:{id:string;source_submission_id:string;assessment_version:number;organization_id:string}) {
  const {data,error:docError}=await admin.from('fde_plan_supplemental_documents').select('*')
    .eq('organization_id',actor.organizationId).eq('source_submission_id',assessment.source_submission_id)
    .order('evidence_revision',{ascending:true});
  if(docError) throw new Error('supplemental_document_read_failed');
  const rows=(data??[]) as SupplementalRow[];
  const files:FdeIntakeFile[]=[];
  const documents:{attachmentId:string;sourceSha256:string;representationDigestSha256:string|null;
    contextDigest:string|null;status:'processed'|'failed';associatedNeedIds:readonly string[]}[]=[];
  let unavailable=false;
  for(const row of rows){
    documents.push({attachmentId:row.id,sourceSha256:row.content_sha256,
      representationDigestSha256:row.representation_digest_sha256,contextDigest:row.context_digest_sha256,
      status:row.status,associatedNeedIds:row.need_ids});
    // A failed file stays pinned and visible but is not evidence. Records are immutable,
    // so it must not block the replacement or the human review that follows it.
    if(row.status==='failed') continue;
    if(row.status!=='processed' || !row.context || !row.representation_digest_sha256 || !row.context_digest_sha256){unavailable=true;continue;}
    try {
      const context=parseAssessmentSupportingFileContext(row.context);
      const contextDigest=hashCanonical({truncated:context.truncated,limitations:context.limitations,sections:context.sections});
      if(context.attachmentId!==row.id || context.sourceSha256!==row.content_sha256
        || context.representationDigestSha256!==row.representation_digest_sha256 || contextDigest!==row.context_digest_sha256) throw new Error('identity');
      files.push({attachmentId:row.id,filename:row.original_filename,sourceSha256:row.content_sha256,
        representationDigestSha256:row.representation_digest_sha256,contextDigest,associatedNeedIds:row.need_ids,
        sectionLabels:context.sections.map(section=>section.label),
        truncated:context.truncated,limitations:context.limitations});
    } catch {unavailable=true;}
  }
  const revision=rows.at(-1)?.evidence_revision??0;
  if(rows.some((row,index)=>row.evidence_revision!==index+1)) unavailable=true;
  const packet=await readWorkflowReviewPacket(assessment.id,actor.organizationId,
    {files,evidenceRevision:revision,documents,unavailable});
  if(packet.status!=='ok' || !packet.packet.fdeIntakePlan) throw new Error('fde_plan_unavailable');
  return {plan:packet.packet.fdeIntakePlan,rows,revision,unavailable,
    followUpAnswers:packet.packet.followUpAnswers,intake:packet.packet.intake};
}

async function snapshot(admin:Admin,actor:Actor,assessment:{id:string;source_submission_id:string;assessment_version:number;organization_id:string},plan:FdeIntakePlan) {
  const digest=hashCanonical(plan);
  const canonical=canonicalJson(plan);
  const find=()=>admin.from('fde_plan_snapshots').select('id,plan_canonical_json')
    .eq('organization_id',actor.organizationId).eq('source_submission_id',assessment.source_submission_id)
    .eq('plan_digest_sha256',digest).maybeSingle();
  const existing=await find();
  if(existing.error) throw new Error('snapshot_read_failed');
  if(existing.data){
    if(existing.data.plan_canonical_json!==canonical) throw new Error('snapshot_collision');
    return {id:existing.data.id as string,digest};
  }
  const inserted=await admin.from('fde_plan_snapshots').insert({organization_id:actor.organizationId,
    source_submission_id:assessment.source_submission_id,assessment_id:assessment.id,
    assessment_version:assessment.assessment_version,evidence_revision:plan.pinnedInputs.supplementalEvidence.evidenceRevision,
    plan_digest_sha256:digest,plan_canonical_json:canonical,created_by_actor_id:actor.actorId}).select('id').single();
  if(inserted.error){
    const retry=await find();
    if(retry.error || !retry.data || retry.data.plan_canonical_json!==canonical) throw new Error('snapshot_write_failed');
    return {id:retry.data.id as string,digest};
  }
  return {id:inserted.data.id as string,digest};
}

export async function readFdePlanApproval(req:Request,assessmentId:string):Promise<Response>{
  const access=await authorized(req,assessmentId);
  if(!access.ok) return access.response;
  try {
    const current=await currentPlan(access.admin,access.actor,access.assessment);
    const digest=hashCanonical(current.plan);
    const snapshotRow=await access.admin.from('fde_plan_snapshots').select('id')
      .eq('organization_id',access.actor.organizationId).eq('source_submission_id',access.assessment.source_submission_id)
      .eq('plan_digest_sha256',digest).maybeSingle();
    if(snapshotRow.error) throw new Error('snapshot_read_failed');
    const reviews=await access.admin.from('fde_plan_reviews')
      .select('id,review_version,disposition,rationale,reviewer_actor_id,resolved_plan_digest_sha256,base_plan_digest_sha256,resolved_plan_canonical_json,created_at')
      .eq('organization_id',access.actor.organizationId).eq('source_submission_id',access.assessment.source_submission_id)
      .order('review_version',{ascending:false});
    if(reviews.error) throw new Error('review_read_failed');
    const history=(reviews.data??[]).map((row,index)=>{const saved=JSON.parse(row.resolved_plan_canonical_json) as {waivedAssumptions?:unknown[]};return {reviewId:row.id,reviewVersion:row.review_version,
      disposition:row.disposition,rationale:row.rationale,createdAt:row.created_at,reviewerActorId:row.reviewer_actor_id,
      resolvedDigest:row.resolved_plan_digest_sha256,
      stale:row.base_plan_digest_sha256!==digest || !access.assessment.isCurrentVersion || index>0,
      waiverCount:(saved.waivedAssumptions??[]).length,waivedAssumptions:saved.waivedAssumptions??[]}});
    const latest=history[0];
    const currentStatus=!latest?'pending_review':latest.stale?'stale':latest.disposition==='approved'
      ?latest.waiverCount>0?'approved_with_customer_waiver':'approved':latest.disposition;
    return Response.json({ok:true,plan:{...current.plan,informationNeeds:current.plan.informationNeeds.map(need=>({
      ...need,waiverEligible:isFdeWaiverEligibleNeed(need,current.plan),
      confirmEligible:isFdeConfirmableNeed(need,current.plan)}))},
      baseSnapshotId:snapshotRow.data?.id??null,baseDigest:digest,evidenceChoices:evidenceChoices(current.plan),
      followUpAnswers:current.followUpAnswers,intake:current.intake,
      lateDocuments:current.rows.map(row=>({id:row.id,filename:row.original_filename,uploadedAt:row.uploaded_at,
        status:row.status,limitations:row.status==='processed' && row.context && typeof row.context==='object'
          ?(row.context as {limitations?:string[]}).limitations??[]:[row.error??'Evidence unavailable'],
        needIds:row.need_ids,downloadUrl:`/api/fde-plans/${assessmentId}/documents/${row.id}`})),
      history,currentStatus,latestReviewVersion:latest?.reviewVersion??0,
      currentResolvedRecommendation:latest && !latest.stale && latest.disposition==='approved'
        ? JSON.parse((reviews.data??[])[0].resolved_plan_canonical_json) : null,
      acknowledgmentText:FDE_WAIVER_ACKNOWLEDGMENT_TEXT,
      acknowledgmentVersion:FDE_WAIVER_ACKNOWLEDGMENT_VERSION});
  } catch { return error('plan_unavailable',503); }
}

export async function recordFdePlanReview(req:Request,assessmentId:string,input:unknown):Promise<Response>{
  const access=await authorized(req,assessmentId);
  if(!access.ok) return access.response;
  const parsed=REVIEW.safeParse(input);
  if(!parsed.success) return error('invalid_review',400);
  try {
    const current=await currentPlan(access.admin,access.actor,access.assessment);
    const currentDigest=hashCanonical(current.plan);
    if(parsed.data.baseDigest!==currentDigest || !access.assessment.isCurrentVersion) return error('stale_or_unavailable_plan',409);
    if(parsed.data.disposition==='approved' && current.unavailable) return error('plan_evidence_unavailable',409);
    const pinned=await snapshot(access.admin,access.actor,access.assessment,current.plan);
    if(parsed.data.baseSnapshotId && parsed.data.baseSnapshotId!==pinned.id) return error('stale_snapshot',409);
    const result=resolveFdePlan(current.plan,parsed.data.resolutions,parsed.data.waivers);
    if(parsed.data.disposition==='approved' && !result.eligible) return Response.json({ok:false,error:'approval_blocked',blockers:result.blockers},{status:409});
    const requestDigest=hashCanonical({actorId:access.actor.actorId,snapshotId:pinned.id,
      expectedReviewVersion:parsed.data.expectedReviewVersion,baseDigest:pinned.digest,disposition:parsed.data.disposition,rationale:parsed.data.rationale,
      resolutions:parsed.data.resolutions,waivers:parsed.data.waivers,resolvedDigest:result.digest});
    const written=await access.admin.rpc('record_fde_plan_review',{
      p_base_snapshot_id:pinned.id,p_base_digest_sha256:pinned.digest,
      p_resolved_canonical_json:canonicalJson(result.resolvedPlan),p_resolved_digest_sha256:result.digest,
      p_disposition:parsed.data.disposition,p_rationale:parsed.data.rationale,
      p_request_digest_sha256:requestDigest,p_actor_id:access.actor.actorId,
      p_resolutions:parsed.data.resolutions,p_waivers:parsed.data.waivers,
      p_expected_review_version:parsed.data.expectedReviewVersion});
    if(written.error) return error(written.error.code==='40001'?'decision_history_changed':'review_write_failed',409);
    const row=Array.isArray(written.data)?written.data[0]:written.data;
    if(!row || !UUID.safeParse(row.review_id).success) return error('review_write_failed',500);
    return Response.json({ok:true,reviewId:row.review_id,reviewVersion:row.review_version,inserted:row.inserted,
      resolvedDigest:result.digest,
      // A replay returns the original receipt; only a new decision can state current status.
      ...(row.inserted?{currentStatus:parsed.data.disposition==='approved' && parsed.data.waivers.length>0
        ?'approved_with_customer_waiver':parsed.data.disposition}:{})},{status:row.inserted?201:200});
  } catch { return error('review_unavailable',503); }
}

export async function uploadFdeSupplementalDocument(req:Request,assessmentId:string):Promise<Response>{
  const access=await authorized(req,assessmentId);
  if(!access.ok) return access.response;
  const form=await req.formData().catch(()=>null);
  if(!form || [...form.keys()].some(key=>key!=='file' && key!=='needIds' && key!=='uploadRequestId')) return error('invalid_upload',400);
  const file=form.get('file');
  if(!(file instanceof File) || !file.name || file.name.length>255 || file.size<1 || file.size>10*1024*1024) return error('invalid_file',400);
  let needIds:unknown;
  try{needIds=JSON.parse(String(form.get('needIds')??'[]'));}catch{return error('invalid_need_ids',400);}
  const needList=z.array(z.string().regex(/^need_[a-f0-9]{64}$/)).max(100).safeParse(needIds);
  if(!needList.success || new Set(needList.data).size!==needList.data.length) return error('invalid_need_ids',400);
  const uploadRequestId=String(form.get('uploadRequestId')??'');
  if(!UUID.safeParse(uploadRequestId).success) return error('invalid_upload_request_id',400);
  try {
    const bytes=new Uint8Array(await file.arrayBuffer());
    const sourceSha=sha256Hex(bytes);
    const requestDigest=hashCanonical({actorId:access.actor.actorId,uploadRequestId,
      filename:file.name,sourceSha,needIds:[...needList.data].sort()});
    const prior=await access.admin.from('fde_plan_supplemental_documents')
      .select('id,evidence_revision,upload_request_digest_sha256')
      .eq('upload_request_id',uploadRequestId).eq('organization_id',access.actor.organizationId)
      .eq('source_submission_id',access.assessment.source_submission_id).maybeSingle();
    if(prior.error) return error('upload_read_failed',500);
    if(prior.data) return prior.data.upload_request_digest_sha256===requestDigest
      ?Response.json({ok:true,documentId:prior.data.id,evidenceRevision:prior.data.evidence_revision,inserted:false})
      :error('upload_idempotency_conflict',409);
    const current=await currentPlan(access.admin,access.actor,access.assessment);
    if(current.unavailable || !access.assessment.isCurrentVersion) return error('plan_evidence_unavailable',409);
    const known=new Set(current.plan.informationNeeds.map(need=>need.needId));
    if(needList.data.some(id=>!known.has(id))) return error('need_not_in_plan',409);
    const pinned=await snapshot(access.admin,access.actor,access.assessment,current.plan);
    const bucket=await access.admin.storage.getBucket('documents');
    if(bucket.error || !bucket.data || bucket.data.public!==false) return error('private_storage_unavailable',503);
    const id=randomUUID();
    const parsedFile=await parseAssessmentSupportingFile({bytes,attachmentId:id,originalFilename:file.name,mediaType:file.type});
    if(parsedFile.status==='failed' && parsedFile.code==='unsupported_file_type') return error('unsupported_file_type',415);
    const storagePath=`${access.actor.organizationId}/fde-plans/${access.assessment.source_submission_id}/${id}`;
    const uploaded=await access.admin.storage.from('documents').upload(storagePath,bytes,{contentType:parsedFile.mediaType,upsert:false});
    if(uploaded.error) return error('storage_write_failed',502);
    let persistenceAttempted=false;
    try {
      const storageVersion=await captureUploadedStorageObjectVersion({admin:access.admin,storageBucket:'documents',storagePath});
      if(!storageVersion) throw new Error('storage_identity_unavailable');
      persistenceAttempted=true;
      const context=parsedFile.status==='processed'?parsedFile.context:null;
      const doc={id,originalFilename:file.name,mediaType:parsedFile.mediaType,byteSize:bytes.byteLength,
        contentSha256:parsedFile.sourceSha256,representationDigestSha256:context?.representationDigestSha256??null,
        contextDigestSha256:context?hashCanonical({truncated:context.truncated,limitations:context.limitations,sections:context.sections}):null,
        storagePath,storageVersion,status:parsedFile.status,
        error:parsedFile.status==='failed'?parsedFile.safeMessage:null,context,
        provenance:{parserVersion:parsedFile.parserVersion,sourceSha256:parsedFile.sourceSha256}};
      const written=await access.admin.rpc('record_fde_plan_supplemental_document',{
        p_document:doc,p_need_ids:needList.data,p_actor_id:access.actor.actorId,
        p_base_snapshot_id:pinned.id,p_upload_request_id:uploadRequestId,p_upload_request_digest_sha256:requestDigest});
      if(written.error) throw new Error('document_write_failed');
      const row=Array.isArray(written.data)?written.data[0]:written.data;
      if(!row || !UUID.safeParse(row.document_id).success) throw new Error('document_receipt_invalid');
      if(!row.inserted) await access.admin.storage.from('documents').remove([storagePath]).catch(()=>undefined);
      return Response.json({ok:true,documentId:row.document_id,evidenceRevision:row.evidence_revision,inserted:row.inserted},{status:row.inserted?201:200});
    } catch {
      let unlinked=!persistenceAttempted;
      if(persistenceAttempted){
        const check=await access.admin.from('fde_plan_supplemental_documents').select('id').eq('id',id).maybeSingle();
        unlinked=!check.error && !check.data;
      }
      if(unlinked) await access.admin.storage.from('documents').remove([storagePath]).catch(()=>undefined);
      return error('document_write_failed',500);
    }
  } catch {return error('upload_unavailable',503);}
}

export async function readFdeSupplementalDocument(req:Request,assessmentId:string,documentId:string):Promise<Response>{
  const access=await authorized(req,assessmentId);
  if(!access.ok) return access.response;
  if(!UUID.safeParse(documentId).success) return error('document_not_found',404);
  const row=await access.admin.from('fde_plan_supplemental_documents')
    .select('storage_bucket,storage_path,original_filename,media_type,content_sha256')
    .eq('id',documentId).eq('organization_id',access.actor.organizationId)
    .eq('source_submission_id',access.assessment.source_submission_id).maybeSingle();
  if(row.error || !row.data) return error('document_not_found',404);
  const blob=await access.admin.storage.from(row.data.storage_bucket).download(row.data.storage_path);
  if(blob.error || !blob.data) return error('document_unavailable',503);
  const bytes=new Uint8Array(await blob.data.arrayBuffer());
  if(sha256Hex(bytes)!==row.data.content_sha256) return error('document_identity_mismatch',409);
  return new Response(bytes,{headers:{'Content-Type':row.data.media_type,
    'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(row.data.original_filename)}`,
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
