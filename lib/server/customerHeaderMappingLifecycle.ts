import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@/lib/extraction/domain/hash';
import { PRICED_SCHEDULE_ASSEMBLY_ROLES } from '@/lib/extraction/pdf/pricedScheduleRoles';
import { CustomerHeaderEvidenceBindingSchema, verifyCustomerHeaderEvidence } from '@/lib/customerAdaptation/headerEvidence';
import { buildReviewedCustomerHeaderMappingRevision, ReviewedCustomerHeaderMappingRevisionSchema,
  type CustomerHeaderMappingContext } from '@/lib/customerAdaptation/headerMapping';
import { hasProjectAdminRole } from '@/lib/projectAdmin';
import type { ActorContext } from '@/lib/server/getActorContext';
import { loadCustomerHeaderEvidenceContext } from '@/lib/server/customerHeaderEvidenceRead';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

const ApprovalRequestSchema = z.object({
  targetRole: z.custom<(typeof PRICED_SCHEDULE_ASSEMBLY_ROLES)[number]>((value) =>
    typeof value === 'string' && (PRICED_SCHEDULE_ASSEMBLY_ROLES as readonly string[]).includes(value)),
  supportingEvidence: CustomerHeaderEvidenceBindingSchema,
  supersedesRevisionId: z.string().uuid().nullable(),
}).strict();
const TransitionRequestSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Failure = { status: 'rejected'; httpStatus: number; reason: string };
const failure = (httpStatus: number, reason: string): Failure => ({ status: 'rejected', httpStatus, reason });
function rpcFailure(error: { code?: string } | null): Failure {
  return error?.code === '42501' ? failure(403, 'mapping_authority_denied')
    : error?.code === 'P0002' ? failure(404, 'mapping_not_found')
      : ['23505', '23514', '22023', '22P02', '55000', 'P0001', '40001'].includes(error?.code ?? '') ? failure(409, 'mapping_lifecycle_conflict')
        : failure(503, 'mapping_storage_unavailable');
}

/** One exact label per persisted reviewed revision. Approval creates immutable
 * history but never an active mapping. All identities and time are server-owned. */
export async function approveCustomerHeaderMapping(actor: ActorContext, body: unknown, admin = getSupabaseAdmin()) {
  if (!hasProjectAdminRole(actor.role)) return failure(403, 'mapping_authority_denied');
  const parsed = ApprovalRequestSchema.safeParse(body);
  if (!parsed.success) return failure(400, 'invalid_mapping_approval');
  if (!admin) return failure(503, 'mapping_storage_unavailable');
  const { supportingEvidence, targetRole, supersedesRevisionId } = parsed.data;
  if (supportingEvidence.organizationId !== actor.organizationId) return failure(404, 'mapping_evidence_not_found');
  const loaded = await loadCustomerHeaderEvidenceContext({ organizationId: actor.organizationId,
    documentId: supportingEvidence.documentId, headerIndex: supportingEvidence.headerIndex }, admin);
  if (loaded.status !== 'loaded') return failure(loaded.status === 'not_found' ? 404 : loaded.status === 'rejected' ? 409 : 503,
    'mapping_evidence_unavailable');
  const verified = verifyCustomerHeaderEvidence(supportingEvidence, loaded.context);
  if (verified.status !== 'verified') return failure(409, verified.reason);
  const revision = buildReviewedCustomerHeaderMappingRevision({ domain: 'eightforge.reviewed-customer-header-mapping',
    schemaVersion: 2, organizationId: actor.organizationId, revisionId: randomUUID(),
    scope: { interpretationBoundary: 'priced_schedule_assembly_header', documentType: verified.binding.documentType,
      sourceSchemaIdentity: verified.binding.sourceSchemaIdentity },
    mappings: [{ sourceLabel: verified.binding.observedHeaderLabel, targetRole, supportingEvidence: { ...verified.binding,
      orderedObservationIds: [...verified.binding.orderedObservationIds] } }],
    humanApproval: { actorId: actor.actorId, approvedAt: new Date().toISOString() }, supersedesRevisionId });
  const { digest: _digest, ...envelope } = revision;
  const { data, error } = await admin.rpc('approve_customer_header_mapping', { p_organization_id: actor.organizationId,
    p_actor_id: actor.actorId, p_revision_envelope_canonical_json: canonicalJson(envelope),
    p_verified_extraction_data: loaded.context.extraction.data });
  if (error) return rpcFailure(error);
  const recorded = Array.isArray(data) ? data[0] : data;
  if (recorded?.revision_id !== revision.revisionId || recorded?.digest !== revision.digest) return failure(503, 'mapping_storage_identity_mismatch');
  return { status: 'approved' as const, revision };
}

export async function transitionCustomerHeaderMapping(actor: ActorContext, revisionId: string,
  action: 'activate' | 'withdraw', body: unknown, admin = getSupabaseAdmin()) {
  if (!hasProjectAdminRole(actor.role)) return failure(403, 'mapping_authority_denied');
  const parsed = TransitionRequestSchema.safeParse(body);
  if (!z.string().uuid().safeParse(revisionId).success || !parsed.success) return failure(400, 'invalid_mapping_transition');
  if (!admin) return failure(503, 'mapping_storage_unavailable');
  const { data, error } = await admin.rpc('transition_customer_header_mapping', { p_organization_id: actor.organizationId,
    p_actor_id: actor.actorId, p_revision_id: revisionId, p_digest: parsed.data.digest, p_action: action });
  if (error) return rpcFailure(error);
  const event = Array.isArray(data) ? data[0] : data;
  if (!event?.event_id || !event?.occurred_at) return failure(503, 'mapping_storage_unavailable');
  return { status: action === 'activate' ? 'activated' as const : 'withdrawn' as const,
    revisionId, digest: parsed.data.digest, eventId: event.event_id, occurredAt: event.occurred_at };
}

/** Reviewed payload shape and its digest are revalidated on every storage read. */
export function parseStoredCustomerHeaderMapping(row: { revision_id: string; organization_id: string;
  digest: string; envelope_canonical_json: string }) {
  try {
    const parsed = ReviewedCustomerHeaderMappingRevisionSchema.safeParse({ ...JSON.parse(row.envelope_canonical_json), digest: row.digest });
    return parsed.success && parsed.data.revisionId === row.revision_id && parsed.data.organizationId === row.organization_id
      && parsed.data.mappings.length === 1 ? parsed.data : null;
  } catch { return null; }
}

/** Load once per processing job. Empty means no active mapping; unreadable or
 * inconsistent storage fails the job rather than pretending the set is empty. */
export async function loadActiveCustomerHeaderMappings(query: { organizationId: string; documentType: string },
  admin = getSupabaseAdmin()): Promise<CustomerHeaderMappingContext | null> {
  if (!admin) throw new Error('customer_mapping_storage_unavailable');
  const { data: active, error, count } = await admin.from('customer_header_mapping_active')
    .select('organization_id, interpretation_boundary, document_type, source_schema_identity, source_label, revision_id, customer_header_mapping_revisions!inner(revision_id,organization_id,digest,envelope_canonical_json)', { count: 'exact' })
    .eq('organization_id', query.organizationId).eq('document_type', query.documentType)
    .eq('interpretation_boundary', 'priced_schedule_assembly_header').limit(1001);
  if (error || !active || active.length > 1000 || count !== active.length) throw new Error('customer_mapping_snapshot_unavailable');
  if (active.length === 0) return null;
  const revisions = [];
  const seen = new Set<string>();
  for (const pointer of active) {
    const stored = Array.isArray(pointer.customer_header_mapping_revisions)
      ? pointer.customer_header_mapping_revisions[0] : pointer.customer_header_mapping_revisions;
    const revision = stored ? parseStoredCustomerHeaderMapping(stored) : null;
    const key = JSON.stringify([pointer.source_schema_identity, pointer.source_label]);
    if (!revision || pointer.organization_id !== query.organizationId || revision.organizationId !== query.organizationId
      || pointer.document_type !== query.documentType || revision.scope.documentType !== query.documentType
      || pointer.interpretation_boundary !== revision.scope.interpretationBoundary
      || pointer.source_schema_identity !== revision.scope.sourceSchemaIdentity
      || pointer.source_label !== revision.mappings[0]!.sourceLabel || pointer.revision_id !== revision.revisionId || seen.has(key)) {
      throw new Error('customer_mapping_snapshot_inconsistent');
    }
    seen.add(key);
    // Reconstruct to clone and deeply freeze the snapshot held for this job.
    const { digest: _digest, ...envelope } = revision;
    revisions.push(buildReviewedCustomerHeaderMappingRevision(envelope));
  }
  return Object.freeze({ organizationId: query.organizationId, documentType: query.documentType,
    revisions: Object.freeze(revisions) });
}

export async function readCustomerHeaderMappingHistory(actor: ActorContext, admin = getSupabaseAdmin()) {
  if (!hasProjectAdminRole(actor.role)) return failure(403, 'mapping_authority_denied');
  if (!admin) return failure(503, 'mapping_storage_unavailable');
  const reads = await Promise.all(['customer_header_mapping_revisions', 'customer_header_mapping_events', 'customer_header_mapping_active']
    .map(table => admin.from(table).select('*', { count: 'exact' }).eq('organization_id', actor.organizationId).limit(1001)));
  if (reads.some(read => read.error || !read.data || read.data.length > 1000 || read.count !== read.data.length)) return failure(503, 'mapping_history_unavailable');
  return { status: 'available' as const, revisions: reads[0]!.data, events: reads[1]!.data, active: reads[2]!.data };
}
