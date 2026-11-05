import { uploadFdeSupplementalDocument } from '@/lib/server/fdePlanApproval';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ assessmentId: string }> }): Promise<Response> {
  return uploadFdeSupplementalDocument(request, (await context.params).assessmentId);
}
