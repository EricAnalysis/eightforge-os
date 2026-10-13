import { removeAssessmentAttachment } from '@/lib/server/workflowAssessmentEvidence';
export async function DELETE(req: Request, context: { params: Promise<{ draftId: string; attachmentId: string }> }) {
  const { draftId, attachmentId } = await context.params;
  return removeAssessmentAttachment(req, draftId, attachmentId);
}
