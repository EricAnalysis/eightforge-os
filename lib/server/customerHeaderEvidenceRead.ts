import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import { produceCustomerHeaderEvidence, type HeaderEvidenceContext } from '@/lib/customerAdaptation/headerEvidence';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

/** Read-only adapter. Organization is supplied by getActorContext at the route;
 * document, project, current extraction and artifact are read from storage. */
export async function loadCustomerHeaderEvidenceContext(
  query: { organizationId: string; documentId: string; headerIndex: number },
  admin = getSupabaseAdmin(),
) {
  if (!admin) return { status: 'unavailable' as const };
  const documentRead = await admin.from('documents').select('id, organization_id, project_id, document_type')
    .eq('organization_id', query.organizationId).eq('id', query.documentId).maybeSingle();
  if (documentRead.error) return { status: 'read_failed' as const };
  if (!documentRead.data) return { status: 'not_found' as const };
  const document = documentRead.data as HeaderEvidenceContext['document'];
  if (!document.project_id) return { status: 'rejected' as const, reason: 'project_ownership_unproven' };
  const projectRead = await admin.from('projects').select('id, organization_id')
    .eq('organization_id', query.organizationId).eq('id', document.project_id).maybeSingle();
  if (projectRead.error) return { status: 'read_failed' as const };
  if (!projectRead.data) return { status: 'rejected' as const, reason: 'project_ownership_unproven' };
  const extractionRead = await admin.from('document_extractions').select('id, organization_id, document_id, created_at, data')
    .eq('organization_id', query.organizationId).eq('document_id', document.id).is('field_key', null)
    .order('created_at', { ascending: false });
  if (extractionRead.error) return { status: 'read_failed' as const };
  // Reuse the same preferred full-blob selection as operational review. Never
  // allow a request to nominate an older extraction or supply extraction JSON.
  const extraction = pickPreferredExtractionBlob(extractionRead.data ?? []);
  if (!extraction) return { status: 'rejected' as const, reason: 'current_extraction_unproven' };
  const pdf = extraction.data?.extraction?.content_layers_v1?.pdf;
  const sourceArtifactId = pdf?.layout_observations_v1?.source_artifact_id;
  if (typeof sourceArtifactId !== 'string') return { status: 'rejected' as const, reason: 'source_artifact_unproven' };
  const artifactRead = await admin.from('extraction_source_artifacts')
    .select('id, organization_id, source_document_id, source_sha256')
    .eq('organization_id', query.organizationId).eq('source_document_id', document.id).eq('id', sourceArtifactId).maybeSingle();
  if (artifactRead.error) return { status: 'read_failed' as const };
  if (!artifactRead.data) return { status: 'rejected' as const, reason: 'source_artifact_unproven' };
  return { status: 'loaded' as const, context: { actorOrganizationId: query.organizationId, document,
    project: projectRead.data, extraction, artifact: artifactRead.data } as HeaderEvidenceContext };
}

export async function readCustomerHeaderEvidence(
  query: { organizationId: string; documentId: string; headerIndex: number },
  admin = getSupabaseAdmin(),
) {
  const loaded = await loadCustomerHeaderEvidenceContext(query, admin);
  return loaded.status === 'loaded' ? produceCustomerHeaderEvidence(loaded.context, query.headerIndex) : loaded;
}
