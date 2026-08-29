import { NextRequest, NextResponse } from 'next/server';

import {
  V2_HUMAN_LABEL_WORKSPACE_ERROR_COPY,
  getV2HumanLabelSource,
  isV2HumanLabelWorkspaceEnabled,
} from '@/lib/evaluation/forgewing/pricingProposalV2HumanLabelWorkspace.server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!isV2HumanLabelWorkspaceEnabled({ host: request.headers.get('host') })) {
    return new NextResponse(null, { status: 404 });
  }
  const sourceDocumentId = request.nextUrl.searchParams.get('sourceDocumentId') ?? '';
  const result = getV2HumanLabelSource(sourceDocumentId);
  if (!result.ok) return NextResponse.json({ code: result.code,
    error: V2_HUMAN_LABEL_WORKSPACE_ERROR_COPY[result.code] },
  { status: 409, headers: { 'Cache-Control': 'no-store' } });
  return new NextResponse(new Uint8Array(result.bytes), { headers: {
    'Content-Type': 'application/pdf', 'Content-Disposition': 'inline',
    'Cache-Control': 'no-store',
  } });
}
