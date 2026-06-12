import { NextResponse } from 'next/server';
import { buildAskResponse } from '@/lib/ask/answerBuilder';
import { classifyQuestion } from '@/lib/ask/classifier';
import type { ClassifiedQuestion } from '@/lib/ask/types';
import type { PortfolioHandoffContext } from '@/lib/ask/portfolioHandoffContext';
import { retrieveProjectTruth } from '@/lib/ask/retrieval';
import { sanitizeAskQuestion, sanitizeScopedIdentifier } from '@/lib/ask/sqlGuardrails';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

type ProjectRow = {
  id: string;
  name: string;
  validation_status: string | null;
  validation_summary_json: unknown;
};

function isPortfolioHandoffContext(value: unknown): value is PortfolioHandoffContext {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.projectId === 'string' &&
    typeof record.projectName === 'string' &&
    typeof record.signalReason === 'string' &&
    typeof record.suggestedProjectQuery === 'string'
  );
}

function classifyHandoffQuestion(question: string, handoffContext: PortfolioHandoffContext): ClassifiedQuestion {
  return {
    intent: handoffContext.openBlockerCount > 0 ? 'validator_question' : 'action_needed',
    confidence: 'high',
    keywords: [
      handoffContext.signalReason,
      handoffContext.validationState,
      handoffContext.snapshotIsStale ? 'stale snapshot' : '',
      handoffContext.openBlockerCount > 0 ? 'blocked' : '',
      handoffContext.openExecutionItemCount > 0 ? 'execution' : '',
    ].filter((value) => value.trim().length > 0),
    originalQuestion: question,
  };
}

export async function POST(request: Request) {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const projectId = sanitizeScopedIdentifier(body?.projectId);
  const question = sanitizeAskQuestion(body?.question);
  const handoffContext = isPortfolioHandoffContext(body?.handoffContext)
    ? body.handoffContext
    : undefined;

  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  if (!question) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }

  const { data: projectData, error: projectError } = await admin
    .from('projects')
    .select('id, name, validation_status, validation_summary_json')
    .eq('organization_id', actor.actor.organizationId)
    .eq('id', projectId)
    .maybeSingle();

  if (projectError || !projectData) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const project = projectData as ProjectRow;
  const classified = handoffContext
    ? classifyHandoffQuestion(question, handoffContext)
    : classifyQuestion(question);
  const retrieval = await retrieveProjectTruth({
    admin,
    question: classified,
    projectId,
    orgId: actor.actor.organizationId,
    project: {
      id: project.id,
      name: project.name,
      validationStatus: project.validation_status,
      validationSummary: project.validation_summary_json,
    },
  });

  const response = buildAskResponse({
    question: classified,
    retrieval,
    project: {
      id: project.id,
      name: project.name,
      validationStatus: project.validation_status,
      validationSummary: project.validation_summary_json,
    },
    projectId,
    orgId: actor.actor.organizationId,
    handoffContext,
  });

  return NextResponse.json(response);
}
