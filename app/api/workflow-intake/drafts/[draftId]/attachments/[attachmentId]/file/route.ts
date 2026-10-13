import { readAssessmentAttachmentFile } from '@/lib/server/workflowAssessmentEvidence';
export async function GET(req: Request, context: { params: Promise<{ draftId: string; attachmentId: string }> }) {
  const { draftId, attachmentId } = await context.params;
  return readAssessmentAttachmentFile(req, draftId, attachmentId);
}
