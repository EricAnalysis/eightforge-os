import { NextRequest, NextResponse } from 'next/server';

import {
  A3_WORKSPACE_ERROR_COPY,
  completeA3WorkspaceAttestation,
  getA3WorkspaceAttestationState,
  isA3WorkspaceEnabled,
  prepareA3WorkspaceAttestation,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace.server';

export async function POST(request: NextRequest) {
  if (!isA3WorkspaceEnabled({ host: request.headers.get('host') })) {
    return new NextResponse(null, { status: 404 });
  }
  const result = prepareA3WorkspaceAttestation();
  if (!result.ok) {
    return NextResponse.json(
      { code: result.code, error: A3_WORKSPACE_ERROR_COPY[result.code] },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: NextRequest) {
  if (!isA3WorkspaceEnabled({ host: request.headers.get('host') })) {
    return new NextResponse(null, { status: 404 });
  }
  const result = getA3WorkspaceAttestationState();
  if (!result.ok) {
    return NextResponse.json(
      { code: result.code, error: A3_WORKSPACE_ERROR_COPY[result.code] },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(result.status, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PUT(request: NextRequest) {
  if (!isA3WorkspaceEnabled({ host: request.headers.get('host') })) {
    return new NextResponse(null, { status: 404 });
  }
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    input = null;
  }
  const result = completeA3WorkspaceAttestation(input);
  if (!result.ok) {
    return NextResponse.json(
      { code: result.code, error: A3_WORKSPACE_ERROR_COPY[result.code] },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
