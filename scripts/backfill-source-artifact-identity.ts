import 'dotenv/config';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  runSourceArtifactIdentityBackfill,
  SourceIdentityStorageFailure,
  SourceIdentityWriteConflict,
  type SourceIdentityBackfillArtifact,
  type SourceIdentityBackfillDocument,
} from '@/lib/extraction/persistence/sourceArtifactIdentityBackfill';
import { validateSourceIdentityBackfillInvocation } from '@/lib/extraction/persistence/sourceArtifactIdentityBackfillCli';

const STORAGE_BUCKET = 'documents';
function storageVersion(data: unknown): string {
  const row = data as {
    id?: unknown;
    version?: unknown;
    updated_at?: unknown;
    metadata?: { eTag?: unknown; etag?: unknown };
  } | null;
  const parts = [row?.version, row?.id, row?.updated_at, row?.metadata?.eTag ?? row?.metadata?.etag]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  if (parts.length === 0) throw new SourceIdentityStorageFailure('unreadable', 'storage version unavailable');
  return parts.join(':');
}

function storageFailure(error: unknown): SourceIdentityStorageFailure {
  const value = error as { status?: number; statusCode?: number | string } | null;
  const status = Number(value?.statusCode ?? value?.status);
  return new SourceIdentityStorageFailure(
    status === 404 ? 'missing' : 'unreadable',
    status === 404 ? 'storage object missing' : 'storage object unreadable',
  );
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) throw new Error('Missing Supabase URL.');
  const { options, environment } = validateSourceIdentityBackfillInvocation(
    process.argv.slice(2),
    supabaseUrl,
  );
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new Error('Missing Supabase service role key.');
  const admin: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const bucket = admin.storage.from(STORAGE_BUCKET) as unknown as {
    info(path: string): Promise<{ data: unknown; error: unknown }>;
    download(path: string): Promise<{ data: Blob | null; error: unknown }>;
  };

  const report = await runSourceArtifactIdentityBackfill({
    async listDocuments({ afterDocumentId, limit }) {
      let query = admin
        .from('documents')
        .select('id, organization_id, storage_path')
        .eq('organization_id', options.organizationId)
        .order('id', { ascending: true })
        .limit(limit);
      if (options.projectId) query = query.eq('project_id', options.projectId);
      if (afterDocumentId) query = query.gt('id', afterDocumentId);
      const { data, error } = await query;
      if (error) throw new Error('Unable to list backfill documents.');
      return (data ?? []).map((row) => ({
        id: String(row.id),
        organizationId: String(row.organization_id),
        storagePath: typeof row.storage_path === 'string' ? row.storage_path : null,
      } satisfies SourceIdentityBackfillDocument));
    },
    async loadArtifacts(document) {
      const { data, error } = await admin
        .from('extraction_source_artifacts')
        .select('source_sha256, storage_object_version')
        .eq('organization_id', document.organizationId)
        .eq('source_document_id', document.id);
      if (error) throw new Error('Unable to read source identity store.');
      return (data ?? []).map((row) => ({
        sourceSha256: String(row.source_sha256),
        storageObjectVersion: String(row.storage_object_version),
      } satisfies SourceIdentityBackfillArtifact));
    },
    async readStorageVersion(document) {
      const { data, error } = await bucket.info(document.storagePath!);
      if (error || !data) throw storageFailure(error);
      return storageVersion(data);
    },
    async downloadSourceBytes(document) {
      const { data, error } = await bucket.download(document.storagePath!);
      if (error || !data) throw storageFailure(error);
      return {
        bytes: await data.arrayBuffer(),
        suppliedMediaType: data.type || null,
      };
    },
    async recordIdentity(input) {
      const { data, error } = await admin.rpc('record_extraction_source_artifact_identity', {
        payload: {
          organization_id: input.document.organizationId,
          source_document_id: input.document.id,
          source_sha256: input.sourceSha256,
          storage_bucket: STORAGE_BUCKET,
          storage_path: input.document.storagePath,
          storage_object_version: input.storageObjectVersion,
          media_type_sniffed: input.mediaTypeSniffed,
          byte_length: input.byteLength,
          identity_origin: 'backfill',
        },
      });
      if (error) {
        if (error.code === '23505' || error.code === '23514') throw new SourceIdentityWriteConflict();
        throw new Error('Unable to record source identity.');
      }
      const result = data as { outcome?: unknown } | null;
      if (result?.outcome === 'already_populated') return 'already_populated';
      if (result?.outcome === 'newly_populated') return 'newly_populated';
      throw new Error('Source identity recorder returned an invalid outcome.');
    },
  }, {
    write: options.write,
    afterDocumentId: options.afterDocumentId,
    pageSize: options.pageSize,
    maxDocuments: options.maxDocuments,
  });

  process.stdout.write(`${JSON.stringify({
    target: options.target,
    actualHost: environment.actualHost,
    organizationId: options.organizationId,
    projectId: options.projectId,
    ...report,
  }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Source identity backfill failed.'}\n`);
  process.exitCode = 1;
});
