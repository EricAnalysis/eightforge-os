import { readFdeSupplementalDocument } from '@/lib/server/fdePlanApproval';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ assessmentId: string; documentId: string }> }): Promise<Response> {
  const { assessmentId, documentId } = await context.params;
  return readFdeSupplementalDocument(request, assessmentId, documentId);
}
