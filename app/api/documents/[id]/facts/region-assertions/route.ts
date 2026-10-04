import { NextRequest, NextResponse } from 'next/server';

import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import { documentReviewedValueState } from '@/lib/humanFactAssertions/regionBoundAssertions';
import { getActorContext } from '@/lib/server/getActorContext';
import { parseRegionAssertionRequest, prepareRegionAssertionRecord } from '@/lib/server/regionAssertionRequest';
import {
  loadRegionBoundAssertionRows,
  recordRegionBoundAssertion,
  type RegionAssertionClient,
} from '@/lib/server/regionBoundHumanAssertions';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { requestFactOverrideRevalidation } from '@/lib/validator/revalidationRequests';

/**
 * Region-bound human-reviewed values for one document (Forgewing resolution
 * layer B3). EightForge Core: available to every organization, never gated by
 * the Forgewing entitlement, and never AI-authored. The operator's value is the
 * authority. The evidence it binds to is verified against the current
 * extraction here, and the original source text is read from persisted
 * observations rather than taken from the request.
 */

function jsonError(message: string, status: number, code?: string) {
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status });
}

async function loadDocumentContext(admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>, documentId: string) {
  const { data: document, error } = await admin
    .from('documents')
    .select('id, organization_id, project_id')
    .eq('id', documentId)
    .maybeSingle();
  if (error) return { error: error.message } as const;
  const { data: extractions, error: extractionError } = await admin
    .from('document_extractions')
    .select('document_id, created_at, data')
    .eq('document_id', documentId)
    .is('field_key', null)
    .order('created_at', { ascending: false });
  if (extractionError) return { error: extractionError.message } as const;
  const preferred = pickPreferredExtractionBlob(
    (extractions ?? []) as Array<{ document_id: string; created_at: string | null; data: Record<string, unknown> | null }>);
  return { document, extractionData: preferred?.data ?? null } as const;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: documentId } = await params;
  const ctx = await getActorContext(req);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);
  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const context = await loadDocumentContext(admin, documentId);
  if ('error' in context) return jsonError(context.error ?? 'Read failed', 500);
  if (!context.document || context.document.organization_id !== ctx.actor.organizationId) {
    return jsonError('Document not found', 404);
  }
  const read = await loadRegionBoundAssertionRows(admin as unknown as RegionAssertionClient, [documentId]);
  const state = documentReviewedValueState({
    documentId, organizationId: ctx.actor.organizationId, rows: read.rows, extractionData: context.extractionData,
  });
  // Full history, oldest first: nothing superseded or withdrawn is hidden.
  return NextResponse.json({ available: read.status === 'ok', ...state });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: documentId } = await params;
  const ctx = await getActorContext(req);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);
  const { actorId, organizationId } = ctx.actor;
  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await req.json().catch(() => null) as unknown;
  const parsed = parseRegionAssertionRequest(body);
  if (!parsed.ok) return jsonError(parsed.error, parsed.status, parsed.code);

  const context = await loadDocumentContext(admin, documentId);
  if ('error' in context) return jsonError(context.error ?? 'Read failed', 500);
  if (!context.document || context.document.organization_id !== organizationId) {
    return jsonError('Document not found', 404);
  }
  const prepared = prepareRegionAssertionRecord({
    request: parsed.request, organizationId, actorId, documentId, extractionData: context.extractionData,
  });
  if (!prepared.ok) return jsonError(prepared.error, prepared.status, prepared.code);

  const recorded = await recordRegionBoundAssertion(admin as unknown as RegionAssertionClient, prepared.input);
  if (recorded.status === 'unavailable') return jsonError('Reviewed values are not available yet', 503);
  if (recorded.status === 'stale_chain_head') {
    return jsonError('This value was reviewed again in the meantime; reload and supersede the latest review.',
      409, 'stale_chain_head');
  }
  if (recorded.status === 'proposal_not_bound') {
    return jsonError('The suggestion no longer matches this source region; reload and review again.',
      409, 'proposal_not_bound');
  }
  if (recorded.status === 'rejected') return jsonError(recorded.reason, 422);

  const projectId = typeof context.document.project_id === 'string' ? context.document.project_id : null;
  if (projectId && recorded.inserted) {
    // Fire-and-forget so validation never blocks saving a reviewed value.
    void requestFactOverrideRevalidation({ projectId, actorId, factId: recorded.assertionId });
  }
  return NextResponse.json({
    assertionId: recorded.assertionId,
    inserted: recorded.inserted,
    originalSourceText: prepared.input.originalSourceText,
  }, { status: recorded.inserted ? 201 : 200 });
}
