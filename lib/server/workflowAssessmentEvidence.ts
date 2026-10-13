import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { captureUploadedStorageObjectVersion } from '@/lib/extraction/persistence/sourceArtifactIdentity';
import { parseAssessmentSupportingFile } from '@/lib/extraction/assessmentSupportingFile';

const DRAFTS = 'workflow_assessment_drafts';
const ATTACHMENTS = 'workflow_assessment_attachments';
const BUCKET = 'documents';
const MAX_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
export type EvidenceDependencies = {
  actor?: typeof getActorContext;
  admin?: ReturnType<typeof getSupabaseAdmin>;
  parse?: typeof parseAssessmentSupportingFile;
  storageVersion?: typeof captureUploadedStorageObjectVersion;
};
const error = (message: string, status: number) => NextResponse.json({ error: message }, { status });
const fields = 'id,original_filename,media_type,byte_size,status,error,uploaded_at,content_sha256';

async function trusted(req: Request, dependencies: EvidenceDependencies) {
  const actor = await (dependencies.actor ?? getActorContext)(req);
  if (!actor.ok) return { response: error(actor.error, actor.status) };
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() : dependencies.admin;
  if (!admin) return { response: error('Assessment storage is unavailable', 503) };
  return { actor: actor.actor, admin };
}

async function draft(admin: Admin, id: string, org: string) {
  if (!UUID.test(id)) return null;
  const { data, error: failure } = await admin.from(DRAFTS).select('id,state,created_by_actor_id')
    .eq('id', id).eq('organization_id', org).maybeSingle();
  if (failure) throw new Error('Assessment draft read failed');
  return data;
}

/** Identity is exclusively authenticated server context, never a request field. */
export async function createAssessmentDraft(req: Request, dependencies: EvidenceDependencies = {}) {
  const auth = await trusted(req, dependencies);
  if ('response' in auth) return auth.response;
  const id = randomUUID();
  const { error: failure } = await auth.admin.from(DRAFTS).insert({ id,
    organization_id: auth.actor.organizationId, created_by_actor_id: auth.actor.actorId });
  return failure ? error('Could not create assessment', 500)
    : NextResponse.json({ draftId: id }, { status: 201 });
}

export async function listAssessmentAttachments(req: Request, draftId: string, dependencies: EvidenceDependencies = {}) {
  const auth = await trusted(req, dependencies);
  if ('response' in auth) return auth.response;
  if (!await draft(auth.admin, draftId, auth.actor.organizationId)) return error('Assessment not found', 404);
  const { data, error: failure } = await auth.admin.from(ATTACHMENTS).select(fields)
    .eq('draft_id', draftId).eq('organization_id', auth.actor.organizationId).is('removed_at', null)
    .order('uploaded_at', { ascending: true });
  return failure ? error('Could not read files', 500) : NextResponse.json({ attachments: data ?? [] });
}

export async function uploadAssessmentAttachment(req: Request, draftId: string, dependencies: EvidenceDependencies = {}) {
  const auth = await trusted(req, dependencies);
  if ('response' in auth) return auth.response;
  const owner = await draft(auth.admin, draftId, auth.actor.organizationId);
  if (!owner) return error('Assessment not found', 404);
  if (owner.state !== 'open' || owner.created_by_actor_id !== auth.actor.actorId) return error('Assessment cannot be changed', 409);
  const length = Number(req.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES + 64 * 1024) return error('Files must be 10 MB or smaller', 413);
  const form = await req.formData().catch(() => null);
  if (!form || Array.from(form.keys()).some(key => key !== 'file')) return error('Only a file is accepted', 400);
  const file = form.get('file');
  if (!(file instanceof File) || !file.name || file.name.length > 255 || file.size === 0 || file.size > MAX_BYTES) {
    return error('Choose a non-empty file of 10 MB or smaller', 400);
  }
  // Reuse storage, but refuse a public bucket rather than changing shared policy.
  const { data: bucket, error: bucketError } = await auth.admin.storage.getBucket(BUCKET);
  if (bucketError || !bucket || bucket.public !== false) return error('Private assessment file storage is unavailable', 503);
  const id = randomUUID();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = await (dependencies.parse ?? parseAssessmentSupportingFile)({ bytes,
    attachmentId: id, originalFilename: file.name, mediaType: file.type });
  if (parsed.status === 'failed' && parsed.code === 'unsupported_file_type') return error(parsed.safeMessage, 415);
  const storagePath = `${auth.actor.organizationId}/workflow-assessments/${draftId}/${id}`;
  const { error: storageError } = await auth.admin.storage.from(BUCKET).upload(storagePath, bytes,
    { contentType: parsed.mediaType, upsert: false });
  if (storageError) return error('Could not store file', 502);
  let persistenceAttempted = false;
  try {
    const version = await (dependencies.storageVersion ?? captureUploadedStorageObjectVersion)({
      admin: auth.admin, storageBucket: BUCKET, storagePath });
    if (!version) throw new Error('Missing immutable storage version');
    persistenceAttempted = true;
    const { error: failure } = await auth.admin.from(ATTACHMENTS).insert({ id, draft_id: draftId,
      organization_id: auth.actor.organizationId, uploaded_by_actor_id: auth.actor.actorId,
      original_filename: file.name, media_type: parsed.mediaType, byte_size: bytes.byteLength,
      content_sha256: parsed.sourceSha256, storage_bucket: BUCKET, storage_path: storagePath,
      storage_version: version, status: parsed.status === 'processed' ? 'processed' : 'failed',
      error: parsed.status === 'processed' ? null : parsed.safeMessage,
      context: parsed.status === 'processed' ? parsed.context : null,
      representation_digest_sha256: parsed.status === 'processed' ? parsed.context.representationDigestSha256 : null,
      provenance: { parserVersion: parsed.parserVersion, sourceSha256: parsed.sourceSha256 } });
    if (failure) throw new Error('Attachment identity persistence failed');
    return NextResponse.json({ attachment: { id, original_filename: file.name, media_type: parsed.mediaType,
      byte_size: bytes.byteLength, status: parsed.status === 'processed' ? 'processed' : 'failed',
      error: parsed.status === 'processed' ? null : parsed.safeMessage } }, { status: 201 });
  } catch {
    // A transport failure may occur after the database committed. Never remove
    // immutable source bytes unless an independent read proves no link exists.
    let unlinked = !persistenceAttempted;
    if (persistenceAttempted) {
      try {
        const verification = await auth.admin.from(ATTACHMENTS).select('id')
          .eq('id', id).eq('organization_id', auth.actor.organizationId).maybeSingle();
        unlinked = !verification.error && verification.data === null;
      } catch { unlinked = false; }
    }
    if (unlinked) await auth.admin.storage.from(BUCKET).remove([storagePath]).catch(() => undefined);
    return error('Could not preserve file identity; please try again', 500);
  }
}

export async function removeAssessmentAttachment(req: Request, draftId: string, attachmentId: string, dependencies: EvidenceDependencies = {}) {
  const auth = await trusted(req, dependencies);
  if ('response' in auth) return auth.response;
  if (!UUID.test(draftId) || !UUID.test(attachmentId)) return error('File not found', 404);
  const { data, error: failure } = await auth.admin.rpc('remove_workflow_assessment_attachment', {
    p_draft_id: draftId, p_attachment_id: attachmentId,
    p_organization_id: auth.actor.organizationId, p_actor_id: auth.actor.actorId });
  return failure || data !== true ? error('File cannot be removed', 409) : NextResponse.json({ removed: true });
}

/** Streams authenticated evidence, without exposing public or signed URLs. */
export async function readAssessmentAttachmentFile(req: Request, draftId: string, attachmentId: string, dependencies: EvidenceDependencies = {}) {
  const auth = await trusted(req, dependencies);
  if ('response' in auth) return auth.response;
  if (!UUID.test(draftId) || !UUID.test(attachmentId)) return error('File not found', 404);
  const { data, error: failure } = await auth.admin.from(ATTACHMENTS)
    .select('storage_bucket,storage_path,original_filename,media_type,content_sha256')
    .eq('id', attachmentId).eq('draft_id', draftId).eq('organization_id', auth.actor.organizationId)
    .is('removed_at', null).maybeSingle();
  if (failure || !data) return error('File not found', 404);
  const { data: blob, error: downloadError } = await auth.admin.storage.from(data.storage_bucket).download(data.storage_path);
  if (downloadError || !blob) return error('File unavailable', 503);
  const { createHash } = await import('node:crypto');
  const bytes = await blob.arrayBuffer();
  if (createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== data.content_sha256) return error('File identity mismatch', 409);
  return new Response(bytes, { headers: { 'Content-Type': data.media_type,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(data.original_filename)}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** The immutable manifest is the only provider attachment selector. */
export async function loadAssessmentAttachmentContext(admin: Admin, submissionId: string, organizationId: string | null | undefined,
  manifest: unknown) {
  if (manifest == null || (Array.isArray(manifest) && manifest.length === 0)) return [];
  if (!organizationId || !Array.isArray(manifest) || manifest.length > 5) throw new Error('Attachment manifest invalid');
  const ids = manifest.map(item => item?.attachmentId);
  if (ids.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(ids).size !== ids.length) throw new Error('Attachment manifest invalid');
  const { data, error: failure } = await admin.from(ATTACHMENTS)
    .select('id,draft_id,organization_id,content_sha256,context,status,removed_at')
    .eq('draft_id', submissionId).eq('organization_id', organizationId).in('id', ids);
  if (failure || !data || data.length !== manifest.length) throw new Error('Attachment closure failed');
  return manifest.map(item => {
    const row = data.find(candidate => candidate.id === item.attachmentId);
    if (!row || row.organization_id !== organizationId || row.draft_id !== submissionId || row.removed_at
      || row.status !== 'processed' || row.content_sha256 !== item.sourceSha256
      || row.context?.sourceSha256 !== item.sourceSha256
      || row.context?.representationDigestSha256 !== item.representationDigestSha256
      || row.context?.attachmentId !== item.attachmentId) throw new Error('Attachment closure failed');
    return row.context;
  });
}
