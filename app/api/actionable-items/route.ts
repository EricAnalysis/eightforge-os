import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { getCurrentActionableItems } from '@/lib/server/executionQueue';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  try {
    const ctx = await getActorContext(req);
    if (!ctx.ok) return jsonError(ctx.error, ctx.status);

    const url = new URL(req.url);
    const projectId = url.searchParams.get('project_id')?.trim() || undefined;
    const items = await getCurrentActionableItems(ctx.actor.organizationId, {
      project_id: projectId,
    });

    return NextResponse.json(
      { items },
      {
        headers: {
          'Cache-Control': 'private, max-age=120, stale-while-revalidate=30',
        },
      },
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'Failed to load actionable items',
      500,
    );
  }
}
