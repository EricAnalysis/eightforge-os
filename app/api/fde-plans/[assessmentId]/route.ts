import { readFdePlanApproval, recordFdePlanReview } from '@/lib/server/fdePlanApproval';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ assessmentId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return readFdePlanApproval(request, (await context.params).assessmentId);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return recordFdePlanReview(request, (await context.params).assessmentId, await request.json().catch(() => null));
}
