import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ASK_PROJECT_CLAUDE_SYSTEM_PROMPT, askProjectWithClaude } from '@/lib/server/ai/askProject';
import { getClaudeModel } from '@/lib/server/ai/claudeClient';
import { buildAskProjectContext } from '@/lib/server/ai/askProjectContext';
import { getActorContext } from '@/lib/server/getActorContext';
import {
  reserveForgewingProviderCall,
  resolveForgewingWorkflowEligibility,
} from '@/lib/server/forgewingGates';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const runtime = 'nodejs';

const MAX_QUESTION_LENGTH = 1200;
const AI_NOT_CONFIGURED_CODE = 'ai_not_configured';
const AI_NOT_CONFIGURED_MESSAGE = 'AI assistance is not configured.';
const AI_NOT_PERMITTED_CODE = 'forgewing_not_permitted';
const AI_BUDGET_EXHAUSTED_CODE = 'forgewing_budget_exhausted';

/** Ask sends project truth as text. Nothing else is transmitted. */
const ASK_CONTENT_CLASSES = ['text_excerpts'] as const;

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

  // Ask sends customer content to a provider, so it passes the same gates as
  // every Forgewing workflow before any context is built: kill switch, policy,
  // entitlement, data-processing authorization, daily cap.
  const eligibility = await resolveForgewingWorkflowEligibility(admin, {
    organizationId: actor.actor.organizationId,
    workflow: 'project_ask',
    contentClasses: ASK_CONTENT_CLASSES,
  });
  if (!eligibility.eligible) {
    return NextResponse.json(
      { error: 'AI assistance is not enabled for this organization.', code: AI_NOT_PERMITTED_CODE, reason: eligibility.reason },
      { status: 403 },
    );
  }

  // Never spend budget on a call that cannot be made.
  if (isAiNotConfiguredError()) {
    return NextResponse.json(
      { error: AI_NOT_CONFIGURED_MESSAGE, code: AI_NOT_CONFIGURED_CODE },
      { status: 500 },
    );
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

    // One slot of the organization's durable Ask budget, bound to the exact
    // request, immediately before the provider call.
    const requestDigestSha256 = createHash('sha256').update(JSON.stringify([
      'project_ask_v1', getClaudeModel(), ASK_PROJECT_CLAUDE_SYSTEM_PROMPT, question, context,
    ])).digest('hex');
    const reservation = await reserveForgewingProviderCall(admin, {
      organizationId: actor.actor.organizationId,
      requestDigestSha256,
      reservedBy: actor.actor.actorId,
      dailyCap: eligibility.dailyCap,
      workflow: 'project_ask',
    });
    if (reservation.status === 'budget_exhausted') {
      return NextResponse.json(
        { error: 'The daily AI assistance budget for this organization is used up.', code: AI_BUDGET_EXHAUSTED_CODE },
        { status: 429 },
      );
    }
    if (reservation.status !== 'reserved') {
      return NextResponse.json({ error: 'AI assistance is temporarily unavailable.' }, { status: 503 });
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
