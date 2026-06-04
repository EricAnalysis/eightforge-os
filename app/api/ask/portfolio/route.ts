import { NextResponse } from 'next/server';
import { ASK_PORTFOLIO_SYSTEM_PROMPT_VERSION } from '@/lib/ask/canonicalPrompts';
import { buildPortfolioAskAnswer } from '@/lib/ask/portfolioAnswerBuilder';
import { checkPortfolioStaleness } from '@/lib/ask/portfolioStalenessCheck';
import { sanitizeAskQuestion } from '@/lib/ask/sqlGuardrails';
import { getActorContext } from '@/lib/server/getActorContext';
import { loadOperationalQueueModel } from '@/lib/server/operationalQueue';
import { buildPortfolioCommandCenter } from '@/lib/server/portfolioCommandCenter';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const actor = await getActorContext(request);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await request.json().catch(() => ({}));
  const question = sanitizeAskQuestion(body?.query ?? body?.question);
  if (!question) return jsonError('query is required', 400);

  const [portfolio, operations] = await Promise.all([
    buildPortfolioCommandCenter(actor.actor.organizationId),
    loadOperationalQueueModel({
      admin,
      organizationId: actor.actor.organizationId,
    }),
  ]);

  if (!portfolio) return jsonError('Failed to load portfolio aggregates', 500);

  const stalenessByProjectId = checkPortfolioStaleness(operations);

  return NextResponse.json(
    buildPortfolioAskAnswer({
      question,
      portfolio,
      operations,
      stalenessByProjectId,
      promptVersion: ASK_PORTFOLIO_SYSTEM_PROMPT_VERSION,
    }),
  );
}
