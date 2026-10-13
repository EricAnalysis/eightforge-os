import { createAssessmentDraft } from '@/lib/server/workflowAssessmentEvidence';
export async function POST(req: Request) { return createAssessmentDraft(req); }
