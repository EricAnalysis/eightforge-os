import { listAssessmentAttachments, uploadAssessmentAttachment } from '@/lib/server/workflowAssessmentEvidence';
export const runtime = 'nodejs';
type Context = { params: Promise<{ draftId: string }> };
export async function GET(req: Request, context: Context) {
  return listAssessmentAttachments(req, (await context.params).draftId);
}
export async function POST(req: Request, context: Context) {
  return uploadAssessmentAttachment(req, (await context.params).draftId);
}
