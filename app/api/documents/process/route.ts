// app/api/documents/process/route.ts
// Unified POST endpoint that triggers the full document processing pipeline.
// Org is taken only from authenticated actor context; body orgId is ignored.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';
import { processDocument } from '@/lib/pipeline/processDocument';

function jsonError(
  message: string,
  code: string,
  status: number,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json(
    { success: false, code, message, ...extra },
    { status },
  );
}

export async function POST(req: Request) {
  try {
    const actorResult = await getActorContext(req);
    if (!actorResult.ok) {
      return NextResponse.json(
        { success: false, code: 'UNAUTHORIZED', message: actorResult.error },
        { status: actorResult.status },
      );
    }
    const organizationId = actorResult.actor.organizationId;

    const body = await req.json().catch(() => null);
    const documentId = body?.documentId;

    if (!documentId || typeof documentId !== 'string') {
      return jsonError('documentId is required', 'MISSING_DOCUMENT_ID', 400);
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return jsonError('Server not configured', 'SERVER_NOT_CONFIGURED', 503);
    }

    console.log('[documents/process] resolving org', {
      documentId,
      organizationId,
    });

    // --- Verify document exists under the resolved org ---
    const { data: docCheck, error: docCheckError } = await admin
      .from('documents')
      .select('id')
      .eq('id', documentId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    console.log('[documents/process] document lookup', {
      documentId,
      organizationId,
      found: !!docCheck,
      error: docCheckError?.message ?? null,
    });

    if (!docCheck) {
      return jsonError('Document not found', 'DOCUMENT_NOT_FOUND', 404, {
        documentId,
        organizationId,
      });
    }

    // --- Fetch org analysis mode ---
    const { data: orgRow } = await admin
      .from('organizations')
      .select('analysis_mode')
      .eq('id', organizationId)
      .maybeSingle();

    const analysisMode = (orgRow?.analysis_mode as string) ?? 'deterministic';
    if (analysisMode === 'disabled') {
      return jsonError(
        'Document analysis is disabled for this organization',
        'ANALYSIS_DISABLED',
        422,
      );
    }

    console.log('[documents/process] starting pipeline', {
      documentId,
      organizationId,
      analysisMode,
    });

    const result = await processDocument({
      documentId,
      organizationId,
      analysisMode,
      triggeredBy: 'manual',
    });

    console.log('[documents/process] pipeline result', {
      documentId,
      success: result.success,
      jobId: result.jobId ?? null,
      extractionId: result.extraction?.id ?? null,
      error: result.error ?? null,
    });

    if (!result.success) {
      return NextResponse.json(
        { success: false, code: 'PROCESSING_FAILED', message: result.error, jobId: result.jobId },
        { status: 500 },
      );
    }

    return NextResponse.json({ ...result, success: true });
  } catch (err) {
    console.error('[documents/process] unhandled error:', err);
    return jsonError('Processing failed', 'INTERNAL_ERROR', 500);
  }
}
