import { getActorContext } from '@/lib/server/getActorContext';
import { recordWorkflowEngineeringReview } from '@/lib/server/workflowEngineeringReview';
export const runtime='nodejs'; export const dynamic='force-dynamic';
export async function POST(request:Request):Promise<Response>{
 const actor=await getActorContext(request); if(!actor.ok)return Response.json({ok:false,error:'unauthorized'},{status:actor.status});
 let body:unknown; try{body=await request.json();}catch{return Response.json({ok:false,error:'invalid_json'},{status:400});}
 const result=await recordWorkflowEngineeringReview(body,{id:actor.actor.actorId,email:actor.actor.email,role:actor.actor.role});
 if(result.ok)return Response.json(result,{status:result.inserted?201:200,headers:{'Cache-Control':'no-store'}});
 const status=result.code==='reviewer_not_eligible'?403:result.code==='invalid_review'?400:result.code==='not_configured'?503:500;
 return Response.json({ok:false,error:result.code},{status,headers:{'Cache-Control':'no-store'}});
}
