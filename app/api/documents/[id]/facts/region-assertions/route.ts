import { NextRequest, NextResponse } from 'next/server';

import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import {
  CONTRACT_RATE_ROW_FACT_KEY,
  documentReviewedValueState,
  parseReviewedRateRowValue,
  verifyRegionEvidence,
  type SourceRegion,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import { getActorContext } from '@/lib/server/getActorContext';
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

const DIGEST = /^[0-9a-f]{64}$/;

function jsonError(message: string, status: number, code?: string) {
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status });
}

function nonEmpty(value: unknown, max = 4000): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;
}

function parseRegion(value: unknown): SourceRegion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.coordinate_space !== 'string' || !Array.isArray(record.boxes)
    || record.boxes.length === 0 || record.boxes.length > 64) return null;
  const boxes = record.boxes.map((entry) => {
    const box = entry as Record<string, unknown> | null;
    const values = [box?.x_min, box?.x_max, box?.y_min, box?.y_max];
    if (!values.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    const [x_min, x_max, y_min, y_max] = values as number[];
    return x_min! <= x_max! && y_min! <= y_max! ? { x_min: x_min!, x_max: x_max!, y_min: y_min!, y_max: y_max! } : null;
  });
  if (boxes.some((box) => box == null)) return null;
  return { coordinate_space: record.coordinate_space, boxes: boxes as SourceRegion['boxes'] };
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

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return jsonError('Invalid request body', 400);

  const factKey = nonEmpty(body.factKey, 200);
  const reason = nonEmpty(body.reason);
  const anchorKey = nonEmpty(body.anchorKey, 500);
  const idempotencyKey = nonEmpty(body.idempotencyKey, 200);
  const status = body.status === 'withdrawn' ? 'withdrawn' : 'active';
  const page = body.physicalPageNumber;
  const digest = body.pageRepresentationDigest;
  const region = parseRegion(body.sourceRegion);
  const observationIds = Array.isArray(body.sourceObservationIds)
    && body.sourceObservationIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)
    && body.sourceObservationIds.length <= 500
    ? body.sourceObservationIds as string[] : null;
  const supersedes = body.supersedesAssertionId == null ? null : nonEmpty(body.supersedesAssertionId, 64);

  if (!factKey || !reason || !anchorKey || !idempotencyKey || !region || !observationIds
    || typeof page !== 'number' || !Number.isInteger(page) || page < 1
    || typeof digest !== 'string' || !DIGEST.test(digest)
    || (body.supersedesAssertionId != null && !supersedes)) {
    return jsonError('factKey, reason, anchorKey, idempotencyKey, sourceRegion, sourceObservationIds, '
      + 'physicalPageNumber and pageRepresentationDigest are required', 400);
  }
  if (status === 'withdrawn' && !supersedes) return jsonError('A withdrawal must supersede an assertion', 400);
  const value = status === 'withdrawn' ? null : body.value;
  if (status === 'active') {
    if (value === undefined || value === null) return jsonError('value is required', 400);
    if (factKey === CONTRACT_RATE_ROW_FACT_KEY && !parseReviewedRateRowValue(value)) {
      return jsonError('A reviewed rate row needs description, unit_type and a numeric rate_amount', 400);
    }
    // Final authority over machine rows needs a source-bound target.
    if (factKey === CONTRACT_RATE_ROW_FACT_KEY && observationIds.length === 0) {
      return jsonError('A reviewed rate row must cite the source observations it reviews', 400);
    }
  }

  const context = await loadDocumentContext(admin, documentId);
  if ('error' in context) return jsonError(context.error ?? 'Read failed', 500);
  if (!context.document || context.document.organization_id !== organizationId) {
    return jsonError('Document not found', 404);
  }
  const evidence = verifyRegionEvidence({
    extractionData: context.extractionData,
    physicalPageNumber: page,
    pageRepresentationDigest: digest,
    sourceObservationIds: observationIds,
  });
  if (evidence.status === 'rejected') {
    return jsonError('The source region no longer matches the current extraction; reload the page and review again.',
      409, evidence.reason);
  }

  const recorded = await recordRegionBoundAssertion(admin as unknown as RegionAssertionClient, {
    organizationId,
    actorId,
    sourceDocumentId: documentId,
    factKey,
    assertedValue: value,
    status,
    reason,
    sourceArtifactId: evidence.sourceArtifactId,
    physicalPageNumber: page,
    sourceRegion: region,
    pageRepresentationDigest: digest,
    parserVersion: evidence.parserVersion,
    sourceObservationIds: observationIds,
    originalSourceText: evidence.originalSourceText,
    anchorKey,
    supersedesAssertionId: supersedes,
    idempotencyKey,
  });
  if (recorded.status === 'unavailable') return jsonError('Reviewed values are not available yet', 503);
  if (recorded.status === 'stale_chain_head') {
    return jsonError('This value was reviewed again in the meantime; reload and supersede the latest review.',
      409, 'stale_chain_head');
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
    originalSourceText: evidence.originalSourceText,
  }, { status: recorded.inserted ? 201 : 200 });
}
