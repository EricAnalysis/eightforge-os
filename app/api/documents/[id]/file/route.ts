import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

const BUCKET = 'documents';
const SIGNED_URL_EXPIRY = 300; // 5 minutes

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const queryOrgId = request.nextUrl.searchParams.get('orgId');

  if (!id) {
    return NextResponse.json({ error: 'Document id is required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  }

  const actorResult = await getActorContext(request);
  const orgId = actorResult.ok ? actorResult.actor.organizationId : queryOrgId;

  if (!orgId) {
    return NextResponse.json({ error: 'orgId query parameter is required' }, { status: 400 });
  }

  const { data: doc, error: docError } = await admin
    .from('documents')
    .select('storage_path, name')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle();

  if (docError) {
    return NextResponse.json({ error: docError.message }, { status: 500 });
  }
  if (!doc || !doc.storage_path) {
    return NextResponse.json({ error: 'Document or file not found' }, { status: 404 });
  }

  const { data: urlData, error: urlError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_path, SIGNED_URL_EXPIRY);

  if (urlError || !urlData?.signedUrl) {
    return NextResponse.json(
      { error: urlError?.message ?? 'Failed to generate signed URL' },
      { status: 502 },
    );
  }

  const filename = doc.storage_path.split('/').pop() ?? doc.name ?? 'document';
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mimeMap: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    txt: 'text/plain',
  };
  const contentType = mimeMap[ext] ?? 'application/octet-stream';

  return NextResponse.json({
    signedUrl: urlData.signedUrl,
    filename,
    contentType,
    ext,
  });
}
