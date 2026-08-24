import { NextRequest, NextResponse } from 'next/server';

import {
  A3_WORKSPACE_ERROR_COPY,
  isA3WorkspaceEnabled,
  loadA3WorkspaceSession,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace.server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!isA3WorkspaceEnabled({ host: request.headers.get('host') })) {
    return new NextResponse(null, { status: 404 });
  }
  const loaded = loadA3WorkspaceSession();
  if (!loaded.ok) {
    return NextResponse.json(
      { error: A3_WORKSPACE_ERROR_COPY[loaded.code], code: loaded.code },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return new NextResponse(new Uint8Array(loaded.sourceBytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="tdot-a3-review-source.pdf"',
      'Cache-Control': 'no-store',
    },
  });
}
