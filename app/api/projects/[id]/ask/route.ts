import { NextResponse } from 'next/server';
import { askProjectWithClaude } from '@/lib/server/ai/askProject';
import { buildAskProjectContext } from '@/lib/server/ai/askProjectContext';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const runtime = 'nodejs';

const MAX_QUESTION_LENGTH = 1200;
const AI_NOT_CONFIGURED_CODE = 'ai_not_configured';
const AI_NOT_CONFIGURED_MESSAGE = 'AI assistance is not configured.';

type ProjectRow = {
  id: string;
  name: string;
  validation_status: string | null;
  validation_summary_json: unknown;
};

function normalizeQuestion(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const question = input.replace(/\s+/g, ' ').trim();
  return question.length > 0 ? question : null;
}

function safeServerErrorMessage(err: unknown): string {
  const fallback = 'Claude project ask failed';
  const message = err instanceof Error ? err.message : fallback;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && message.includes(apiKey)) {
    return fallback;
  }
  return message;
}

function isAiNotConfiguredError(): boolean {
  return !process.env.ANTHROPIC_API_KEY?.trim();
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  const body = await request.json().catch(() => ({}));
  const question = normalizeQuestion(body?.question);
  if (!question) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return NextResponse.json({ error: 'question is too long' }, { status: 400 });
  }

  const { id: projectId } = await params;
  if (!projectId) {
    return NextResponse.json({ error: 'project id is required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  }

  const { data, error } = await admin
    .from('projects')
    .select('id, name, validation_status, validation_summary_json')
    .eq('organization_id', actor.actor.organizationId)
    .eq('id', projectId)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const project = data as ProjectRow;
  if (project.id !== projectId) {
    return NextResponse.json({ error: 'Project context scope mismatch' }, { status: 500 });
  }

  try {
    const context = await buildAskProjectContext({
      admin,
      projectId,
      orgId: actor.actor.organizationId,
      question,
      project,
    });

    if (context.project.id !== projectId || context.scope.projectId !== projectId) {
      return NextResponse.json({ error: 'Project context scope mismatch' }, { status: 500 });
    }

    const answer = await askProjectWithClaude({ question, context });
    return NextResponse.json(answer);
  } catch (err) {
    if (isAiNotConfiguredError()) {
      return NextResponse.json(
        { error: AI_NOT_CONFIGURED_MESSAGE, code: AI_NOT_CONFIGURED_CODE },
        { status: 500 },
      );
    }

    return NextResponse.json({ error: safeServerErrorMessage(err) }, { status: 500 });
  }
}
