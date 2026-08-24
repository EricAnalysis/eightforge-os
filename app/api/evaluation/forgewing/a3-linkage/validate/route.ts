import { NextRequest, NextResponse } from 'next/server';

import {
  A3_WORKSPACE_ERROR_COPY,
  evaluateA3WorkspaceDraft,
  isA3WorkspaceEnabled,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace.server';
import type { A3WorkspaceDraft } from
  '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace';

export async function POST(request: NextRequest) {
  if (!isA3WorkspaceEnabled({ host: request.headers.get('host') })) {
    return new NextResponse(null, { status: 404 });
  }
  let draft: A3WorkspaceDraft;
  try {
    draft = await request.json() as A3WorkspaceDraft;
  } catch {
    return NextResponse.json({ code: 'REVIEW_SESSION_INVALID', error: 'REVIEW SESSION INVALID' }, { status: 400 });
  }
  const result = evaluateA3WorkspaceDraft(draft);
  if (!result.ok) {
    return NextResponse.json(
      { code: result.code, error: A3_WORKSPACE_ERROR_COPY[result.code] },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(
    { status: result.status, failureReasons: result.status === 'manifest_ready' ? [] : result.failureReasons },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
