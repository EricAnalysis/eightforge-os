// app/api/documents/[id]/analyze/route.ts
// Server-side document analysis: auth, org scope, storage download, extraction, insert.

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { extractDocument } from '@/lib/server/documentExtraction';
import type { ExtractionPayload } from '@/lib/server/documentExtraction';

const BUCKET = process.env.NEXT_PUBLIC_SUPABASE_DOCS_BUCKET || 'documents';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

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

    // Use authClient (user JWT) for the document lookup so that the user's
    // authenticated session is used. This fixes cases where the admin service-role
    // key is misconfigured or unavailable, while still enforcing org-scoped access
    // through both the explicit organization_id filter and any RLS policy.
    const { data: docRow, error: docError } = await authClient
      .from('documents')
      .select('id, title, name, document_type, storage_path')
      .eq('id', documentId)
      .eq('organization_id', organizationId)
      .single();

    if (docError || !docRow) {
      return jsonError('Document not found', 404);
    }

    const storagePath = docRow.storage_path;
    if (!storagePath || typeof storagePath !== 'string') {
      return jsonError('Document file path is missing', 400);
    }

    const { data: fileData, error: downloadError } = await admin.storage
      .from(BUCKET)
      .download(storagePath);

    if (downloadError || !fileData) {
      return jsonError('Unable to download file from storage', 502);
    }

    const bytes = await fileData.arrayBuffer();
    const fileName = docRow.name ?? storagePath.split('/').pop() ?? 'file';
    const mimeType = (fileData as Blob & { type?: string }).type ?? null;

    const metadata = {
      id: docRow.id,
      title: docRow.title ?? null,
      name: docRow.name ?? fileName,
      document_type: docRow.document_type ?? null,
      storage_path: storagePath,
    };

    const payload = (await extractDocument(
      metadata,
      bytes,
      mimeType,
      fileName
    )) as ExtractionPayload;

    const { data: inserted, error: insertError } = await admin
      .from('document_extractions')
      .insert({ document_id: documentId, data: payload })
      .select('id, data, created_at')
      .single();

    if (insertError) {
      return jsonError('Analysis failed. Please try again.', 500);
    }

    return NextResponse.json({
      success: true,
      extraction: inserted,
    });
  } catch (err) {
    console.error('Analyze route error:', err);
    return NextResponse.json(
      { error: 'Analysis failed. Please try again.' },
      { status: 500 }
    );
  }
}
