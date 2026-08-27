import { NextRequest, NextResponse } from 'next/server';

import {
  V2_HUMAN_LABEL_WORKSPACE_ERROR_COPY,
  completeV2HumanLabelPackage,
  isV2HumanLabelWorkspaceEnabled,
} from '@/lib/evaluation/forgewing/pricingProposalV2HumanLabelWorkspace.server';

export async function PUT(request: NextRequest) {
  if (!isV2HumanLabelWorkspaceEnabled({ host: request.headers.get('host') })) {
    return new NextResponse(null, { status: 404 });
  }
  let input: unknown;
  try { input = await request.json(); } catch { input = null; }
  const result = completeV2HumanLabelPackage(input);
  if (!result.ok) return NextResponse.json({ code: result.code,
    error: V2_HUMAN_LABEL_WORKSPACE_ERROR_COPY[result.code] },
  { status: 409, headers: { 'Cache-Control': 'no-store' } });
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
