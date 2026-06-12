import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { getActionableItemSummary } from '@/lib/server/executionQueue';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  try {
    const ctx = await getActorContext(req);
    if (!ctx.ok) return jsonError(ctx.error, ctx.status);

    const summary = await getActionableItemSummary(ctx.actor.organizationId);
    return NextResponse.json(
      { summary },
      {
        headers: {
          'Cache-Control': 'private, max-age=120, stale-while-revalidate=30',
        },
      },
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'Failed to load actionable summary',
      500,
    );
  }
}
