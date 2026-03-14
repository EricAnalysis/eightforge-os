// app/api/documents/process/route.ts
// Unified POST endpoint that triggers the full document processing pipeline.

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { processDocument } from '@/lib/pipeline/processDocument';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const documentId = body?.documentId;
    if (!documentId || typeof documentId !== 'string') {
      return jsonError('documentId is required', 400);
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return jsonError('Unauthorized', 401);
    }

    const supabaseUrl =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return jsonError('Server not configured', 503);
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
      return jsonError('Server not configured', 503);
    }

    const { data: profile } = await admin
      .from('user_profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();

    if (!profile?.organization_id) {
      return jsonError('User profile not found', 403);
    }

    const organizationId = profile.organization_id as string;

    const { data: docCheck } = await admin
      .from('documents')
      .select('id')
      .eq('id', documentId)
      .eq('organization_id', organizationId)
      .single();

    if (!docCheck) {
      return jsonError('Document not found', 404);
    }

    const { data: orgRow } = await admin
      .from('organizations')
      .select('analysis_mode')
      .eq('id', organizationId)
      .single();

    const analysisMode = (orgRow?.analysis_mode as string) ?? 'deterministic';
    if (analysisMode === 'disabled') {
      return NextResponse.json(
        { error: 'Document analysis is disabled for this organization' },
        { status: 422 },
      );
    }

    const result = await processDocument({
      documentId,
      organizationId,
      analysisMode,
      triggeredBy: 'manual',
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error, jobId: result.jobId },
        { status: 500 },
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error('[documents/process] error:', err);
    return jsonError('Processing failed', 500);
  }
}
