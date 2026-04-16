import { NextRequest, NextResponse } from 'next/server';
import { resolveTruth, type TruthQueryType } from '@/lib/server/truthEngine';

const VALID_TYPES = new Set<TruthQueryType>(['invoice', 'rate_code', 'project', 'contract']);

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

  const { projectId, type, value } = body as Record<string, unknown>;

  if (typeof projectId !== 'string' || !projectId.trim()) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  if (typeof type !== 'string' || !VALID_TYPES.has(type as TruthQueryType)) {
    return NextResponse.json(
      { error: 'type must be one of: invoice, rate_code, project, contract' },
      { status: 400 },
    );
  }

  const queryValue = typeof value === 'string' ? value.trim() : '';
  if (type !== 'project' && type !== 'contract' && !queryValue) {
    return NextResponse.json({ error: 'value is required for invoice and rate_code queries' }, { status: 400 });
  }

  const start = Date.now();
  let result;
  try {
    result = await resolveTruth(projectId.trim(), type as TruthQueryType, queryValue);
  } catch (err) {
    console.error('[truth/query] engine error', { projectId, type, queryValue, err });
    return NextResponse.json({ error: 'Internal error resolving truth' }, { status: 500 });
  }
  console.log('[truth/query]', { projectId, type, queryValue, found: result != null, ms: Date.now() - start });

  if (!result) {
    return NextResponse.json({ error: 'Could not resolve truth for this query' }, { status: 404 });
  }

  return NextResponse.json(result);
}
