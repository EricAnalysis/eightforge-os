// app/api/documents/[id]/analyze/route.ts
// Enqueues a document analysis job and dispatches to the job processor.

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { createAnalysisJob } from '@/lib/server/analysisJobService';
import {
  admitDocumentProcessing,
  closeDocumentProcessingAdmission,
  documentProcessingRefusalResponse,
} from '@/lib/server/documentProcessingHold';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: documentId } = await params;
    if (!documentId) {
      return jsonError('Document not found', 404);
    }

    const authHeader = _req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;
    if (!token) {
      return jsonError('Unauthorized', 401);
    }

    const supabaseUrl =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return jsonError('Server analysis is not configured', 503);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser();
    if (userError || !user) {
      return jsonError('Unauthorized', 401);
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return jsonError('Server analysis is not configured', 503);
    }

    const { data: profile, error: profileError } = await admin
      .from('user_profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile?.organization_id) {
      return jsonError('User profile not found', 403);
    }

    const organizationId = profile.organization_id as string;

    const { data: docRow, error: docError } = await authClient
      .from('documents')
      .select('id, title, name, document_type, storage_path')
      .eq('id', documentId)
      .eq('organization_id', organizationId)
      .single();

    if (docError || !docRow) {
      return jsonError('Document not found', 404);
    }

    const { data: orgRow, error: orgError } = await authClient
      .from('organizations')
      .select('analysis_mode')
      .eq('id', organizationId)
      .single();

    const analysisMode = (orgError ? 'deterministic' : orgRow?.analysis_mode) ?? 'deterministic';
    if (analysisMode === 'disabled') {
      return NextResponse.json(
        { error: 'Document analysis is disabled for this organization' },
        { status: 422 }
      );
    }

    // Processing hold: decided by the database before any job row exists.
    const admission = await admitDocumentProcessing(admin, {
      entryPoint: 'document_analyze',
      organizationId,
      documentId,
    });
    if (admission.status !== 'admitted') {
      return documentProcessingRefusalResponse(admission);
    }

    let processorRes: Response;
    let processorData: Record<string, unknown> & { success?: unknown; error?: unknown; extraction?: unknown };
    try {
      const job = await createAnalysisJob({
        documentId,
        organizationId,
        analysisMode,
        triggeredBy: 'manual',
        admissionId: admission.admissionId,
      });

      if (!job) {
        await closeDocumentProcessingAdmission(admin, admission.admissionId, 'failed');
        return jsonError('Failed to create analysis job', 503);
      }

      processorRes = await fetch(`${BASE_URL}/api/jobs/process/${job.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });

      processorData = await processorRes.json().catch(() => ({}));
      await closeDocumentProcessingAdmission(
        admin,
        admission.admissionId,
        processorRes.ok && processorData.success === true ? 'completed' : 'failed',
      );
      if (processorRes.ok && processorData.success === true) {
        return NextResponse.json({
          success: true,
          extraction: processorData.extraction,
          jobId: job.id,
        });
      }
    } catch (err) {
      await closeDocumentProcessingAdmission(admin, admission.admissionId, 'failed');
      throw err;
    }

    const status = processorRes.status;
    const errorMessage =
      typeof processorData.error === 'string'
        ? processorData.error
        : 'Analysis failed. Please try again.';
    return NextResponse.json({ error: errorMessage }, { status });
  } catch (err) {
    console.error('Analyze route error:', err);
    return NextResponse.json(
      { error: 'Analysis failed. Please try again.' },
      { status: 500 }
    );
  }
}
