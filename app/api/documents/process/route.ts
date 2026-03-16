// app/api/documents/process/route.ts
// Unified POST endpoint that triggers the full document processing pipeline.

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
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
    const body = await req.json().catch(() => null);
    const documentId = body?.documentId;
    const bodyOrgId: string | undefined = body?.orgId;

    if (!documentId || typeof documentId !== 'string') {
      return jsonError('documentId is required', 'MISSING_DOCUMENT_ID', 400);
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return jsonError('Server not configured', 'SERVER_NOT_CONFIGURED', 503);
    }

    // --- Resolve the authenticated user (best-effort) ---
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    let profileOrgId: string | null = null;

    if (token) {
      const supabaseUrl =
        process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      if (supabaseUrl && anonKey) {
        const authClient = createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const {
          data: { user },
        } = await authClient.auth.getUser();

        if (user) {
          const { data: profile } = await admin
            .from('user_profiles')
            .select('organization_id')
            .eq('id', user.id)
            .single();
          profileOrgId = (profile?.organization_id as string) ?? null;
        }
      }
    }

    const organizationId = bodyOrgId ?? profileOrgId;

    if (!organizationId) {
      return jsonError(
        'Unable to resolve organization. Provide orgId or authenticate.',
        'ORG_RESOLUTION_FAILED',
        400,
      );
    }

    console.log('[documents/process] resolving org', {
      documentId,
      profileOrgId,
      bodyOrgId: bodyOrgId ?? null,
      resolvedOrgId: organizationId,
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
