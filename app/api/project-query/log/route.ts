import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }

  const { projectId, query, trace } = body as Record<string, unknown>;
  if (typeof projectId !== 'string' || !projectId.trim()) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }
  if (typeof query !== 'string' || !query.trim()) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 });
  }

  console.log('[project-query]', {
    projectId: projectId.trim(),
    query: query.trim(),
    trace: typeof trace === 'object' && trace != null ? trace : null,
    ts: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}

