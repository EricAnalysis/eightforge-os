import { NextRequest, NextResponse } from 'next/server';

import {
  V2_HUMAN_LABEL_WORKSPACE_ERROR_COPY,
  isV2HumanLabelWorkspaceEnabled,
  validateV2HumanLabelWorkspaceDraft,
} from '@/lib/evaluation/forgewing/pricingProposalV2HumanLabelWorkspace.server';

export async function POST(request: NextRequest) {
  if (!isV2HumanLabelWorkspaceEnabled({ host: request.headers.get('host') })) {
    return new NextResponse(null, { status: 404 });
  }
  let input: unknown;
  try { input = await request.json(); } catch { input = null; }
  const result = validateV2HumanLabelWorkspaceDraft(input);
  if (!result.ok) return NextResponse.json({ code: result.code,
    error: V2_HUMAN_LABEL_WORKSPACE_ERROR_COPY[result.code] },
  { status: 409, headers: { 'Cache-Control': 'no-store' } });
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
