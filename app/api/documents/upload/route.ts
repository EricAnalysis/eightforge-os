// app/api/documents/upload/route.ts
// Server-side document upload: Storage upload + DB insert using service role.
// Org is taken only from authenticated actor context; client-supplied orgId is ignored.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';
import { normalizeDocumentTypeInput } from '@/lib/documentTypes';

const BUCKET = 'documents';

type ErrorCode =
  | 'storage_upload_failed'
  | 'document_insert_failed'
  | 'unexpected_exception'
  | 'bad_request'
  | 'server_not_configured'
  | 'unauthenticated'
  | 'forbidden';

function jsonError(
  code: ErrorCode,
  message: string,
  status: number,
  details?: unknown,
) {
  return NextResponse.json(
    { ok: false, error: { code, message, details } },
    { status },
  );
}

function safeFilename(name: string) {
  // Keep it simple and predictable; Storage paths shouldn't contain odd chars.
  return name.replace(/[^\w.\-() ]+/g, '_').replace(/\s+/g, ' ').trim();
}

export async function POST(req: Request) {
  let uploadedPath: string | null = null;

  try {
    const admin = getSupabaseAdmin();
    if (!admin) {
      return jsonError('server_not_configured', 'Server not configured', 503);
    }

    const actorResult = await getActorContext(req);
    if (!actorResult.ok) {
      return jsonError(
        actorResult.status === 401 ? 'unauthenticated' : 'forbidden',
        actorResult.error,
        actorResult.status,
      );
    }
    const orgId = actorResult.actor.organizationId;

    const form = await req.formData().catch(() => null);
    if (!form) {
      return jsonError('bad_request', 'Invalid multipart form data', 400);
    }

    const title = form.get('title');
    const documentType = form.get('documentType');
    const domain = form.get('domain');
    const projectId = form.get('projectId');
    const file = form.get('file');

    let normalizedDocumentType: string | null = null;
    try {
      normalizedDocumentType = normalizeDocumentTypeInput(documentType);
    } catch (error) {
      return jsonError(
        'bad_request',
        error instanceof Error ? error.message : 'Invalid documentType',
        400,
      );
    }

    if (typeof title !== 'string' || !title.trim()) {
      return jsonError('bad_request', 'title is required', 400);
    }
    if (!(file instanceof File)) {
      return jsonError('bad_request', 'file is required', 400);
    }

    const ts = Date.now();
    const filename = safeFilename(file.name || 'document');
    uploadedPath = `${orgId}/${ts}-${filename}`;

    const { error: storageError } = await admin.storage
      .from(BUCKET)
      .upload(uploadedPath, file, {
        contentType: file.type || undefined,
        upsert: false,
      });

    if (storageError) {
      return jsonError(
        'storage_upload_failed',
        storageError.message || 'Storage upload failed',
        502,
        storageError,
      );
    }

    const insertPayload = {
      organization_id: orgId,
      project_id: typeof projectId === 'string' && projectId ? projectId : null,
      title: title.trim(),
      name: filename,
      storage_path: uploadedPath,
      document_type: normalizedDocumentType,
      domain: typeof domain === 'string' && domain.trim() ? domain.trim() : null,
      status: 'uploaded',
      processing_status: 'uploaded',
    };

    const { data: insertedDoc, error: dbError } = await admin
      .from('documents')
      .insert(insertPayload)
      .select('id, title, name, document_type, status, created_at')
      .single();

    if (dbError || !insertedDoc) {
      // Cleanup: delete uploaded file if DB insert fails.
      try {
        await admin.storage.from(BUCKET).remove([uploadedPath]);
      } catch {
        // best-effort cleanup only
      }
      return jsonError(
        'document_insert_failed',
        dbError?.message ?? 'Failed to create document record',
        500,
        dbError ?? { insertedDoc: null },
      );
    }

    return NextResponse.json({
      ok: true,
      doc: insertedDoc,
      storagePath: uploadedPath,
    });
  } catch (err) {
    console.error('[documents/upload] error:', err);

    // Best-effort cleanup if something threw after upload.
    try {
      const admin = getSupabaseAdmin();
      if (admin && uploadedPath) {
        await admin.storage.from(BUCKET).remove([uploadedPath]);
      }
    } catch {
      // ignore cleanup failure
    }

    const message = err instanceof Error ? err.message : 'Unexpected exception';
    return jsonError('unexpected_exception', message, 500);
  }
}

