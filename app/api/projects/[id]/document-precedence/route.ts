import { NextResponse } from 'next/server';
import {
  AUTHORITY_STATUS_VALUES,
  DOCUMENT_RELATIONSHIP_TYPES,
  DOCUMENT_SUBTYPE_VALUES,
  GOVERNING_DOCUMENT_FAMILIES,
  canonicalizeRelationshipType,
  getDocumentRelationshipLabel,
  type AuthorityStatus,
  type DocumentRelationshipType,
  type DocumentSubtype,
  type GoverningDocumentFamily,
} from '@/lib/documentPrecedence';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { enforceRequiredActivityEvent } from '@/lib/server/activity/requiredActivityEvent';
import { getActorContext } from '@/lib/server/getActorContext';
import { loadProjectDocumentPrecedenceSnapshot } from '@/lib/server/documentPrecedence';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { requestDocumentPrecedenceRevalidation } from '@/lib/validator/revalidationRequests';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function titleize(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function documentLabel(document: { title?: string | null; name?: string | null } | null | undefined): string {
  return document?.title?.trim() || document?.name || 'Document';
}

/**
 * Structural metadata only. The PATCH body carries operator-authored free text
 * — a duplicate disposition's `reason` and `evidenceReference` — which is
 * retained deliberately in the append-only activity record and must not be
 * copied into generic server logs. Identifiers and enum-shaped fields are
 * allow-listed here; nothing else from the body is logged.
 */
export function buildPatchLogMetadata(
  projectId: string,
  action: string,
  body: unknown,
): Record<string, unknown> {
  const source = (body ?? {}) as Record<string, unknown>;
  const identifier = (key: string): string | undefined =>
    typeof source[key] === 'string' ? (source[key] as string) : undefined;

  return {
    action,
    projectId,
    ...(identifier('documentId') ? { documentId: identifier('documentId') } : {}),
    ...(identifier('sourceDocumentId') ? { sourceDocumentId: identifier('sourceDocumentId') } : {}),
    ...(identifier('targetDocumentId') ? { targetDocumentId: identifier('targetDocumentId') } : {}),
    ...(identifier('relationshipId') ? { relationshipId: identifier('relationshipId') } : {}),
    ...(identifier('relationshipType') ? { relationshipType: identifier('relationshipType') } : {}),
    ...(typeof source.reason === 'string' ? { hasReason: true } : {}),
    ...(typeof source.evidenceReference === 'string' ? { hasEvidenceReference: true } : {}),
  };
}

/** Postgres unique_violation, raised when a concurrent request won the edge. */
const UNIQUE_VIOLATION = '23505';

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function duplicateRelationshipWouldCycle(params: {
  sourceDocumentId: string;
  targetDocumentId: string;
  relationships: readonly { source_document_id: string; target_document_id: string; relationship_type: string }[];
}): boolean {
  const targetsBySource = new Map<string, Set<string>>();
  for (const relationship of params.relationships) {
    if (canonicalizeRelationshipType(relationship.relationship_type) !== 'duplicate_of') continue;
    const targets = targetsBySource.get(relationship.source_document_id) ?? new Set<string>();
    targets.add(relationship.target_document_id);
    targetsBySource.set(relationship.source_document_id, targets);
  }
  const proposedTargets = targetsBySource.get(params.sourceDocumentId) ?? new Set<string>();
  proposedTargets.add(params.targetDocumentId);
  targetsBySource.set(params.sourceDocumentId, proposedTargets);

  const pending = [params.targetDocumentId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === params.sourceDocumentId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(targetsBySource.get(current) ?? []));
  }
  return false;
}

function assertPrecedenceRank(value: unknown): asserts value is number | null {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('precedence_rank must be a number or null');
  }
}

function coercePrecedenceRank(value: unknown): number | null {
  const safePrecedenceRank =
    value === true ? 1
      : value === false ? null
        : typeof value === 'number' && Number.isFinite(value) ? value
          : null;

  assertPrecedenceRank(safePrecedenceRank);
  return safePrecedenceRank;
}

async function logTruthMutationActivity(params: {
  organizationId: string;
  projectId: string;
  entityType: 'document' | 'project';
  entityId: string;
  eventType:
    | 'governing_document_changed'
    | 'document_precedence_changed'
    | 'document_relationship_created'
    | 'document_relationship_changed'
    | 'document_subtype_updated';
  actorId: string;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
}) {
  const result = await logActivityEvent({
    organization_id: params.organizationId,
    project_id: params.projectId,
    entity_type: params.entityType,
    entity_id: params.entityId,
    event_type: params.eventType,
    changed_by: params.actorId,
    old_value: params.oldValue ?? null,
    new_value: params.newValue ?? null,
  });

  if (!result.ok) {
    console.error('[document-precedence] failed to log activity event', {
      projectId: params.projectId,
      entityType: params.entityType,
      entityId: params.entityId,
      eventType: params.eventType,
      error: result.error,
    });
  }
  return result;
}

async function projectExists(
  projectId: string,
  organizationId: string,
): Promise<
  | { exists: true; admin: NonNullable<ReturnType<typeof getSupabaseAdmin>> }
  | { exists: false; error: string; status: number }
> {
  const admin = getSupabaseAdmin();
  if (!admin) return { error: 'Server not configured', status: 503 as const, exists: false };

  const { data, error } = await admin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) return { error: error.message, status: 500 as const, exists: false };
  if (!data) return { error: 'Project not found', status: 404 as const, exists: false };

  return { exists: true as const, admin };
}

function isValidFamily(value: unknown): value is GoverningDocumentFamily {
  return typeof value === 'string' &&
    GOVERNING_DOCUMENT_FAMILIES.includes(value as GoverningDocumentFamily);
}

function isValidAuthorityStatus(value: unknown): value is AuthorityStatus {
  return typeof value === 'string' &&
    AUTHORITY_STATUS_VALUES.includes(value as AuthorityStatus);
}

function isValidRelationshipType(value: unknown): value is DocumentRelationshipType {
  return typeof value === 'string' &&
    DOCUMENT_RELATIONSHIP_TYPES.includes(value as DocumentRelationshipType);
}

function isValidDocumentSubtype(value: unknown): value is DocumentSubtype {
  return typeof value === 'string'
    && DOCUMENT_SUBTYPE_VALUES.includes(value as DocumentSubtype);
}

type CanonicalRelationshipType =
  ReturnType<typeof canonicalizeRelationshipType> extends infer T
    ? Exclude<T, null>
    : never;

async function persistManualFamilyOrder(params: {
  organizationId: string;
  orderedDocumentIds: string[];
}) {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false as const, error: 'Server not configured', status: 503 as const };

  for (const [index, documentId] of params.orderedDocumentIds.entries()) {
    const precedence_rank = coercePrecedenceRank(index === 0 ? 1 : 2);
    const payload = {
      operator_override_precedence: true,
      precedence_rank,
    } as const;

    console.log('[document-precedence update]', {
      action: 'persist_manual_family_order',
      documentId,
      payload,
    });
    const { error } = await admin
      .from('documents')
      .update(payload)
      .eq('id', documentId)
      .eq('organization_id', params.organizationId);

    if (error) {
      return { ok: false as const, error: error.message, status: 500 as const };
    }
  }

  return { ok: true as const };
}

async function clearManualFamilyOrder(params: {
  organizationId: string;
  documentIds: string[];
}) {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false as const, error: 'Server not configured', status: 503 as const };

  for (const documentId of params.documentIds) {
    const precedence_rank = coercePrecedenceRank(null);
    const payload = {
      operator_override_precedence: false,
      precedence_rank,
    } as const;

    console.log('[document-precedence update]', {
      action: 'clear_manual_family_order',
      documentId,
      payload,
    });
    const { error } = await admin
      .from('documents')
      .update(payload)
      .eq('id', documentId)
      .eq('organization_id', params.organizationId);

    if (error) {
      return { ok: false as const, error: error.message, status: 500 as const };
    }
  }

  return { ok: true as const };
}

async function logGoverningDocumentDiffs(params: {
  organizationId: string;
  projectId: string;
  actorId: string;
  previousFamilies: Awaited<ReturnType<typeof loadProjectDocumentPrecedenceSnapshot>>['families'];
  nextFamilies: Awaited<ReturnType<typeof loadProjectDocumentPrecedenceSnapshot>>['families'];
  previousDocumentById: Map<string, { title?: string | null; name?: string | null }>;
  nextDocumentById: Map<string, { title?: string | null; name?: string | null }>;
}) {
  for (const nextFamily of params.nextFamilies) {
    const previousFamily =
      params.previousFamilies.find((candidate) => candidate.family === nextFamily.family) ?? null;
    const previousId = previousFamily?.governing_document_id ?? null;
    const nextId = nextFamily.governing_document_id ?? null;
    if (previousId === nextId) continue;

    const previousDocument = previousId
      ? params.previousDocumentById.get(previousId) ?? null
      : null;
    const nextDocument = nextId
      ? params.nextDocumentById.get(nextId) ?? null
      : null;

    await logTruthMutationActivity({
      organizationId: params.organizationId,
      projectId: params.projectId,
      entityType: nextId || previousId ? 'document' : 'project',
      entityId: nextId ?? previousId ?? params.projectId,
      eventType: 'governing_document_changed',
      actorId: params.actorId,
      oldValue: {
        family: nextFamily.family,
        family_label: titleize(nextFamily.family),
        governing_document_id: previousId,
        governing_document_title: previousDocument ? documentLabel(previousDocument) : null,
      },
      newValue: {
        family: nextFamily.family,
        family_label: titleize(nextFamily.family),
        governing_document_id: nextId,
        governing_document_title: nextDocument ? documentLabel(nextDocument) : null,
      },
    });
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);

  const projectResult = await projectExists(projectId, ctx.actor.organizationId);
  if (!projectResult.exists) return jsonError(projectResult.error, projectResult.status);

  try {
    const snapshot = await loadProjectDocumentPrecedenceSnapshot(projectResult.admin, {
      organizationId: ctx.actor.organizationId,
      projectId,
    });
    return NextResponse.json({
      ok: true,
      documents: snapshot.documents,
      relationships: snapshot.relationships,
      families: snapshot.families,
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'Failed to load document precedence',
      500,
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);

  const projectResult = await projectExists(projectId, ctx.actor.organizationId);
  if (!projectResult.exists) return jsonError(projectResult.error, projectResult.status);

  const body = await request.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : null;
  if (!action) return jsonError('action is required', 400);

  console.log('[document-precedence PATCH]', buildPatchLogMetadata(projectId, action, body));

  const snapshot = await loadProjectDocumentPrecedenceSnapshot(projectResult.admin, {
    organizationId: ctx.actor.organizationId,
    projectId,
  });
  let shouldRefreshValidator = false;
  let duplicateAuditAlreadyLogged = false;
  let truthMutationAuditPlan:
    | {
        kind: 'set_governing';
        family: GoverningDocumentFamily;
        documentId: string;
        previousGoverningDocumentId: string | null;
      }
    | {
        kind: 'move';
        family: GoverningDocumentFamily;
        documentId: string;
        direction: 'up' | 'down';
        previousOrder: string[];
      }
    | {
        kind: 'revert_to_automatic';
        family: GoverningDocumentFamily;
        previousOrder: string[];
        previousGoverningDocumentId: string | null;
      }
    | {
        kind: 'set_authority_status';
        documentId: string;
        previousAuthorityStatus: string | null;
        nextAuthorityStatus: AuthorityStatus;
      }
    | {
        kind: 'link_relationship';
        relationshipId: string;
        sourceDocumentId: string;
        targetDocumentId: string;
        relationshipType: CanonicalRelationshipType;
        reason: string | null;
        evidenceReference: string | null;
      }
    | {
        kind: 'delete_relationship';
        relationshipId: string;
        sourceDocumentId: string;
        targetDocumentId: string;
        relationshipType: CanonicalRelationshipType;
        reason: string | null;
        evidenceReference: string | null;
        createdBy: string | null;
        createdAt: string | null;
      }
    | {
        kind: 'set_document_subtype';
        documentId: string;
        previousDocumentSubtype: string | null;
        nextDocumentSubtype: DocumentSubtype | null;
      }
    | null = null;

  try {
    if (action === 'set_governing') {
      const family = body.family;
      const documentId = typeof body.documentId === 'string' ? body.documentId : null;
      if (!isValidFamily(family) || !documentId) {
        return jsonError('family and documentId are required', 400);
      }

      const familySnapshot = snapshot.families.find((item) => item.family === family);
      if (!familySnapshot) return jsonError('Family not found', 404);

      const orderedDocumentIds = familySnapshot.documents.map((document) => document.id);
      if (!orderedDocumentIds.includes(documentId)) return jsonError('Document not found in family', 404);

      if (family === 'contract') {
        const selectedDocument = snapshot.documents.find((document) => document.id === documentId) ?? null;
        const selectedDocumentType =
          typeof selectedDocument?.document_type === 'string' ? selectedDocument.document_type : null;
        if (!selectedDocumentType) {
          return jsonError('Document type is required to scope governing update', 400);
        }

        const { data: documents, error: documentsError } = await projectResult.admin
          .from('documents')
          .select('id')
          .eq('organization_id', ctx.actor.organizationId)
          .eq('project_id', projectId)
          .eq('document_type', selectedDocumentType);

        if (documentsError) return jsonError(documentsError.message, 500);

        const contractDocumentIds = (documents ?? [])
          .map((doc) => doc.id as string)
          .filter(Boolean);

        if (!contractDocumentIds.includes(documentId)) {
          return jsonError('Document not found in contract role', 404);
        }

        for (const contractDocumentId of contractDocumentIds) {
          const precedence_rank = coercePrecedenceRank(contractDocumentId === documentId ? 1 : 2);
          const payload = {
            operator_override_precedence: true,
            precedence_rank,
          } as const;

          console.log('[document-precedence update]', {
            action,
            documentId: contractDocumentId,
            payload,
          });

          const { error } = await projectResult.admin
            .from('documents')
            .update(payload)
            .eq('id', contractDocumentId)
            .eq('organization_id', ctx.actor.organizationId);

          if (error) return jsonError(error.message, 500);
        }
      } else {
        const nextOrder = [documentId, ...orderedDocumentIds.filter((id) => id !== documentId)];
        const updateResult = await persistManualFamilyOrder({
          organizationId: ctx.actor.organizationId,
          orderedDocumentIds: nextOrder,
        });
        if (!updateResult.ok) return jsonError(updateResult.error, updateResult.status);
      }
      truthMutationAuditPlan = {
        kind: 'set_governing',
        family,
        documentId,
        previousGoverningDocumentId: familySnapshot.governing_document_id ?? null,
      };
      shouldRefreshValidator = true;
    } else if (action === 'move') {
      const family = body.family;
      const documentId = typeof body.documentId === 'string' ? body.documentId : null;
      const direction = body.direction === 'up' || body.direction === 'down' ? body.direction : null;
      if (!isValidFamily(family) || !documentId || !direction) {
        return jsonError('family, documentId, and direction are required', 400);
      }

      const familySnapshot = snapshot.families.find((item) => item.family === family);
      if (!familySnapshot) return jsonError('Family not found', 404);

      const nextOrder = familySnapshot.documents.map((document) => document.id);
      const currentIndex = nextOrder.indexOf(documentId);
      if (currentIndex === -1) return jsonError('Document not found in family', 404);

      const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex >= 0 && targetIndex < nextOrder.length) {
        const [moved] = nextOrder.splice(currentIndex, 1);
        nextOrder.splice(targetIndex, 0, moved);
      }

      const updateResult = await persistManualFamilyOrder({
        organizationId: ctx.actor.organizationId,
        orderedDocumentIds: nextOrder,
      });
      if (!updateResult.ok) return jsonError(updateResult.error, updateResult.status);
      truthMutationAuditPlan = {
        kind: 'move',
        family,
        documentId,
        direction,
        previousOrder: familySnapshot.documents.map((document) => document.id),
      };
      shouldRefreshValidator = true;
    } else if (action === 'revert_to_automatic') {
      const family = body.family;
      if (!isValidFamily(family)) return jsonError('family is required', 400);

      const familySnapshot = snapshot.families.find((item) => item.family === family);
      if (!familySnapshot) return jsonError('Family not found', 404);

      const updateResult = await clearManualFamilyOrder({
        organizationId: ctx.actor.organizationId,
        documentIds: familySnapshot.documents.map((document) => document.id),
      });
      if (!updateResult.ok) return jsonError(updateResult.error, updateResult.status);
      truthMutationAuditPlan = {
        kind: 'revert_to_automatic',
        family,
        previousOrder: familySnapshot.documents.map((document) => document.id),
        previousGoverningDocumentId: familySnapshot.governing_document_id ?? null,
      };
      shouldRefreshValidator = true;
    } else if (action === 'set_authority_status') {
      const documentId = typeof body.documentId === 'string' ? body.documentId : null;
      const authorityStatus = body.authorityStatus;
      if (!documentId || !isValidAuthorityStatus(authorityStatus)) {
        return jsonError('documentId and authorityStatus are required', 400);
      }

      const projectDocument = snapshot.documents.find((document) => document.id === documentId);
      if (!projectDocument) return jsonError('Document not found', 404);

      const precedence_rank = coercePrecedenceRank(
        authorityStatus === 'superseded' ? null : projectDocument.precedence_rank ?? null,
      );
      const payload = {
        authority_status: authorityStatus,
        operator_override_precedence: authorityStatus === 'superseded' ? false : projectDocument.operator_override_precedence ?? false,
        precedence_rank,
      } as const;

      console.log('[document-precedence update]', {
        action,
        documentId,
        payload,
      });

      const { error } = await projectResult.admin
        .from('documents')
        .update(payload)
        .eq('id', documentId)
        .eq('organization_id', ctx.actor.organizationId);

      if (error) return jsonError(error.message, 500);
      truthMutationAuditPlan = {
        kind: 'set_authority_status',
        documentId,
        previousAuthorityStatus: projectDocument.authority_status ?? null,
        nextAuthorityStatus: authorityStatus,
      };
      shouldRefreshValidator = true;
    } else if (action === 'set_document_subtype') {
      const documentId = typeof body.documentId === 'string' ? body.documentId : null;
      const rawDocumentSubtype = body.documentSubtype;
      const documentSubtype =
        rawDocumentSubtype == null
          ? null
          : isValidDocumentSubtype(rawDocumentSubtype)
            ? rawDocumentSubtype
            : null;
      if (!documentId || (rawDocumentSubtype != null && documentSubtype == null)) {
        return jsonError('documentId and a valid documentSubtype are required', 400);
      }

      const projectDocument = snapshot.documents.find((document) => document.id === documentId);
      if (!projectDocument) return jsonError('Document not found', 404);

      const { error } = await projectResult.admin
        .from('documents')
        .update(() => {
          const payload = { document_subtype: documentSubtype } as const;
          console.log('[document-precedence update]', {
            action,
            documentId,
            payload,
          });
          return payload;
        })
        .eq('id', documentId)
        .eq('organization_id', ctx.actor.organizationId);

      if (error) return jsonError(error.message, 500);
      truthMutationAuditPlan = {
        kind: 'set_document_subtype',
        documentId,
        previousDocumentSubtype: projectDocument.document_subtype ?? null,
        nextDocumentSubtype: documentSubtype,
      };
      shouldRefreshValidator = true;
    } else if (action === 'link_relationship') {
      const sourceDocumentId = typeof body.sourceDocumentId === 'string' ? body.sourceDocumentId : null;
      const targetDocumentId = typeof body.targetDocumentId === 'string' ? body.targetDocumentId : null;
      const relationshipType = body.relationshipType;
      const reason = optionalText(body.reason);
      const evidenceReference = optionalText(body.evidenceReference);
      const canonicalRelationshipType = canonicalizeRelationshipType(
        typeof relationshipType === 'string' ? relationshipType : null,
      );

      if (
        !sourceDocumentId
        || !targetDocumentId
        || !isValidRelationshipType(relationshipType)
        || !canonicalRelationshipType
      ) {
        return jsonError('sourceDocumentId, targetDocumentId, and relationshipType are required', 400);
      }
      if (sourceDocumentId === targetDocumentId) {
        return jsonError('A document cannot relate to itself', 400);
      }
      if (canonicalRelationshipType === 'duplicate_of' && !reason) {
        return jsonError('A reason is required for a duplicate disposition', 400);
      }

      const documentIds = new Set(snapshot.documents.map((document) => document.id));
      if (!documentIds.has(sourceDocumentId) || !documentIds.has(targetDocumentId)) {
        return jsonError('Related documents must belong to the project', 400);
      }
      if (canonicalRelationshipType === 'duplicate_of') {
        const conflictingDisposition = snapshot.relationships.some((relationship) =>
          relationship.source_document_id === sourceDocumentId
          && canonicalizeRelationshipType(relationship.relationship_type) === 'duplicate_of'
          && relationship.target_document_id !== targetDocumentId,
        );
        if (conflictingDisposition) {
          return jsonError('The duplicate document already points to a different original', 409);
        }
        if (duplicateRelationshipWouldCycle({
          sourceDocumentId,
          targetDocumentId,
          relationships: snapshot.relationships,
        })) {
          return jsonError('A duplicate disposition cannot create a cycle', 409);
        }
      }
      const relationshipAlreadyExists = snapshot.relationships.some((relationship) =>
        relationship.source_document_id === sourceDocumentId &&
        relationship.target_document_id === targetDocumentId &&
        canonicalizeRelationshipType(relationship.relationship_type) === canonicalRelationshipType,
      );

      // Insert rather than upsert so this request learns whether it actually
      // created the edge. Audit compensation deletes by row id, and only the
      // request that created a row may delete it — an upsert cannot distinguish
      // its own insert from a concurrent one, and would also rewrite the
      // original row's `created_by` provenance.
      let createdRelationshipId: string | null = null;
      if (!relationshipAlreadyExists) {
        const insertResult = await projectResult.admin
          .from('document_relationships')
          .insert({
            organization_id: ctx.actor.organizationId,
            project_id: projectId,
            source_document_id: sourceDocumentId,
            target_document_id: targetDocumentId,
            relationship_type: canonicalRelationshipType,
            created_by: ctx.actor.actorId,
          })
          .select('id')
          .maybeSingle();

        if (insertResult.error) {
          // A concurrent request won the unique edge index. The edge the caller
          // asked for exists, so this is not an error, but this request did not
          // create it: it records no creation event and must never compensate
          // by deleting the winner's row.
          if (insertResult.error.code !== UNIQUE_VIOLATION) {
            return jsonError(insertResult.error.message, 500);
          }
        } else {
          createdRelationshipId = insertResult.data?.id ?? null;
        }
      }

      if (createdRelationshipId) {
        truthMutationAuditPlan = {
          kind: 'link_relationship',
          relationshipId: createdRelationshipId,
          sourceDocumentId,
          targetDocumentId,
          relationshipType: canonicalRelationshipType,
          reason,
          evidenceReference,
        };
      }

      // Fire-and-forget so validation never blocks relationship saves.
      shouldRefreshValidator = true;
    } else if (action === 'delete_relationship') {
      const relationshipId = typeof body.relationshipId === 'string' ? body.relationshipId : null;
      if (!relationshipId) {
        return jsonError('relationshipId is required', 400);
      }

      const relationship = snapshot.relationships.find((candidate) => candidate.id === relationshipId) ?? null;
      if (!relationship?.id) {
        return jsonError('Relationship not found', 404);
      }

      const relationshipType = canonicalizeRelationshipType(relationship.relationship_type);
      if (!relationshipType) {
        return jsonError('Relationship type is invalid', 400);
      }
      const reason = optionalText(body.reason);
      const evidenceReference = optionalText(body.evidenceReference);
      if (relationshipType === 'duplicate_of' && !reason) {
        return jsonError('A reason is required to reverse a duplicate disposition', 400);
      }
      if (relationshipType === 'duplicate_of' && !relationship.created_at) {
        return jsonError('Duplicate disposition history is incomplete and cannot be reversed safely', 500);
      }

      // Returning the deleted row proves this request is the one that removed
      // it. Without that, a request whose delete was a no-op (a concurrent
      // reversal got there first) would still compensate on audit failure and
      // resurrect a row the winner had legitimately removed.
      const { data: deletedRelationship, error } = await projectResult.admin
        .from('document_relationships')
        .delete()
        .eq('id', relationshipId)
        .eq('organization_id', ctx.actor.organizationId)
        .eq('project_id', projectId)
        .select('id')
        .maybeSingle();

      if (error) return jsonError(error.message, 500);
      if (!deletedRelationship) {
        return jsonError('Relationship not found', 404);
      }

      truthMutationAuditPlan = {
        kind: 'delete_relationship',
        relationshipId,
        sourceDocumentId: relationship.source_document_id,
        targetDocumentId: relationship.target_document_id,
        relationshipType,
        reason,
        evidenceReference,
        createdBy: relationship.created_by ?? null,
        createdAt: relationship.created_at ?? null,
      };
      shouldRefreshValidator = true;
    } else {
      return jsonError('Unsupported action', 400);
    }

    if (
      truthMutationAuditPlan?.kind === 'link_relationship'
      && truthMutationAuditPlan.relationshipType === 'duplicate_of'
    ) {
      const auditPlan = truthMutationAuditPlan;
      const documentById = new Map(snapshot.documents.map((document) => [document.id, document]));
      const activityResult = await logTruthMutationActivity({
        organizationId: ctx.actor.organizationId,
        projectId,
        entityType: 'document',
        entityId: auditPlan.sourceDocumentId,
        eventType: 'document_relationship_created',
        actorId: ctx.actor.actorId,
        oldValue: null,
        newValue: {
          source_document_id: auditPlan.sourceDocumentId,
          source_document_title: documentLabel(documentById.get(auditPlan.sourceDocumentId)),
          target_document_id: auditPlan.targetDocumentId,
          target_document_title: documentLabel(documentById.get(auditPlan.targetDocumentId)),
          affected_document_ids: [auditPlan.sourceDocumentId, auditPlan.targetDocumentId],
          relationship_type: 'duplicate_of',
          relationship_label: getDocumentRelationshipLabel('duplicate_of'),
          reason: auditPlan.reason,
          evidence_reference: auditPlan.evidenceReference,
        },
      });
      const requiredAudit = await enforceRequiredActivityEvent({
        activityResult,
        rollback: async () => {
          // Row-specific: this deletes the row this request inserted and no
          // other. Matching the edge tuple instead would let a compensating
          // request remove a concurrent request's successfully audited row.
          // Org and project stay on the predicate as defense in depth.
          const { error } = await projectResult.admin
            .from('document_relationships')
            .delete()
            .eq('id', auditPlan.relationshipId)
            .eq('organization_id', ctx.actor.organizationId)
            .eq('project_id', projectId);
          return { error };
        },
        auditFailureMessage: 'Duplicate disposition was not recorded because its audit event could not be retained',
        rollbackFailurePrefix: 'Duplicate disposition audit failed and rollback failed',
      });
      if (!requiredAudit.ok) return jsonError(requiredAudit.error, requiredAudit.status);
      duplicateAuditAlreadyLogged = true;
    } else if (
      truthMutationAuditPlan?.kind === 'delete_relationship'
      && truthMutationAuditPlan.relationshipType === 'duplicate_of'
    ) {
      const auditPlan = truthMutationAuditPlan;
      const documentById = new Map(snapshot.documents.map((document) => [document.id, document]));
      const activityResult = await logTruthMutationActivity({
        organizationId: ctx.actor.organizationId,
        projectId,
        entityType: 'document',
        entityId: auditPlan.sourceDocumentId,
        eventType: 'document_relationship_changed',
        actorId: ctx.actor.actorId,
        oldValue: {
          relationship_id: auditPlan.relationshipId,
          source_document_id: auditPlan.sourceDocumentId,
          source_document_title: documentLabel(documentById.get(auditPlan.sourceDocumentId)),
          target_document_id: auditPlan.targetDocumentId,
          target_document_title: documentLabel(documentById.get(auditPlan.targetDocumentId)),
          affected_document_ids: [auditPlan.sourceDocumentId, auditPlan.targetDocumentId],
          relationship_type: 'duplicate_of',
          relationship_label: getDocumentRelationshipLabel('duplicate_of'),
          relationship_created_by: auditPlan.createdBy,
          relationship_created_at: auditPlan.createdAt,
        },
        newValue: {
          action: 'removed',
          reason: auditPlan.reason,
          evidence_reference: auditPlan.evidenceReference,
        },
      });
      const requiredAudit = await enforceRequiredActivityEvent({
        activityResult,
        rollback: async () => {
          const { error } = await projectResult.admin
            .from('document_relationships')
            .insert({
              id: auditPlan.relationshipId,
              organization_id: ctx.actor.organizationId,
              project_id: projectId,
              source_document_id: auditPlan.sourceDocumentId,
              target_document_id: auditPlan.targetDocumentId,
              relationship_type: 'duplicate_of',
              created_by: auditPlan.createdBy,
              created_at: auditPlan.createdAt,
            });
          return { error };
        },
        auditFailureMessage: 'Duplicate disposition was not reversed because its audit event could not be retained',
        rollbackFailurePrefix: 'Duplicate disposition reversal audit failed and rollback failed',
      });
      if (!requiredAudit.ok) return jsonError(requiredAudit.error, requiredAudit.status);
      duplicateAuditAlreadyLogged = true;
    }

    const refreshed = await loadProjectDocumentPrecedenceSnapshot(projectResult.admin, {
      organizationId: ctx.actor.organizationId,
      projectId,
    });

    if (truthMutationAuditPlan) {
      const auditPlan = truthMutationAuditPlan;
      const documentById = new Map(refreshed.documents.map((document) => [document.id, document]));
      const previousDocumentById = new Map(snapshot.documents.map((document) => [document.id, document]));

      if (auditPlan.kind === 'set_governing') {
        const refreshedFamily = refreshed.families.find((item) => item.family === auditPlan.family);
        const previousGoverningDocument = auditPlan.previousGoverningDocumentId
          ? previousDocumentById.get(auditPlan.previousGoverningDocumentId) ?? null
          : null;
        const nextGoverningDocument = refreshedFamily?.governing_document_id
          ? documentById.get(refreshedFamily.governing_document_id) ?? null
          : documentById.get(auditPlan.documentId) ?? null;

        await logTruthMutationActivity({
          organizationId: ctx.actor.organizationId,
          projectId,
          entityType: 'document',
          entityId: auditPlan.documentId,
          eventType: 'governing_document_changed',
          actorId: ctx.actor.actorId,
          oldValue: {
            family: auditPlan.family,
            family_label: titleize(auditPlan.family),
            governing_document_id: auditPlan.previousGoverningDocumentId,
            governing_document_title: previousGoverningDocument ? documentLabel(previousGoverningDocument) : null,
          },
          newValue: {
            family: auditPlan.family,
            family_label: titleize(auditPlan.family),
            governing_document_id: refreshedFamily?.governing_document_id ?? auditPlan.documentId,
            governing_document_title: nextGoverningDocument ? documentLabel(nextGoverningDocument) : null,
            ordered_document_ids: refreshedFamily?.documents.map((document) => document.id) ?? [],
          },
        });
      } else if (auditPlan.kind === 'move') {
        const refreshedFamily = refreshed.families.find((item) => item.family === auditPlan.family);
        const movedDocument = documentById.get(auditPlan.documentId)
          ?? previousDocumentById.get(auditPlan.documentId)
          ?? null;

        await logTruthMutationActivity({
          organizationId: ctx.actor.organizationId,
          projectId,
          entityType: 'document',
          entityId: auditPlan.documentId,
          eventType: 'document_precedence_changed',
          actorId: ctx.actor.actorId,
          oldValue: {
            family: auditPlan.family,
            family_label: titleize(auditPlan.family),
            document_id: auditPlan.documentId,
            document_title: documentLabel(movedDocument),
            ordered_document_ids: auditPlan.previousOrder,
          },
          newValue: {
            family: auditPlan.family,
            family_label: titleize(auditPlan.family),
            document_id: auditPlan.documentId,
            document_title: documentLabel(movedDocument),
            ordered_document_ids: refreshedFamily?.documents.map((document) => document.id) ?? auditPlan.previousOrder,
            direction: auditPlan.direction,
          },
        });
      } else if (auditPlan.kind === 'revert_to_automatic') {
        const refreshedFamily = refreshed.families.find((item) => item.family === auditPlan.family);
        const previousGoverningDocument = auditPlan.previousGoverningDocumentId
          ? previousDocumentById.get(auditPlan.previousGoverningDocumentId) ?? null
          : null;
        const nextGoverningDocument = refreshedFamily?.governing_document_id
          ? documentById.get(refreshedFamily.governing_document_id) ?? null
          : null;

        await logTruthMutationActivity({
          organizationId: ctx.actor.organizationId,
          projectId,
          entityType: 'project',
          entityId: projectId,
          eventType: 'document_precedence_changed',
          actorId: ctx.actor.actorId,
          oldValue: {
            family: auditPlan.family,
            family_label: titleize(auditPlan.family),
            ordered_document_ids: auditPlan.previousOrder,
            governing_document_id: auditPlan.previousGoverningDocumentId,
            governing_document_title: previousGoverningDocument ? documentLabel(previousGoverningDocument) : null,
            precedence_mode: 'manual',
          },
          newValue: {
            family: auditPlan.family,
            family_label: titleize(auditPlan.family),
            ordered_document_ids: refreshedFamily?.documents.map((document) => document.id) ?? [],
            governing_document_id: refreshedFamily?.governing_document_id ?? null,
            governing_document_title: nextGoverningDocument ? documentLabel(nextGoverningDocument) : null,
            precedence_mode: 'automatic',
          },
        });
      } else if (auditPlan.kind === 'set_authority_status') {
        const nextDocument = documentById.get(auditPlan.documentId)
          ?? previousDocumentById.get(auditPlan.documentId)
          ?? null;

        await logTruthMutationActivity({
          organizationId: ctx.actor.organizationId,
          projectId,
          entityType: 'document',
          entityId: auditPlan.documentId,
          eventType: 'document_precedence_changed',
          actorId: ctx.actor.actorId,
          oldValue: {
            document_id: auditPlan.documentId,
            document_title: documentLabel(nextDocument),
            authority_status: auditPlan.previousAuthorityStatus,
          },
          newValue: {
            document_id: auditPlan.documentId,
            document_title: documentLabel(nextDocument),
            authority_status: auditPlan.nextAuthorityStatus,
          },
        });
      } else if (auditPlan.kind === 'link_relationship') {
        const sourceDocument = documentById.get(auditPlan.sourceDocumentId)
          ?? previousDocumentById.get(auditPlan.sourceDocumentId)
          ?? null;
        const targetDocument = documentById.get(auditPlan.targetDocumentId)
          ?? previousDocumentById.get(auditPlan.targetDocumentId)
          ?? null;

        if (!duplicateAuditAlreadyLogged) await logTruthMutationActivity({
          organizationId: ctx.actor.organizationId,
          projectId,
          entityType: 'document',
          entityId: auditPlan.sourceDocumentId,
          eventType: 'document_relationship_created',
          actorId: ctx.actor.actorId,
          oldValue: null,
          newValue: {
            source_document_id: auditPlan.sourceDocumentId,
            source_document_title: documentLabel(sourceDocument),
            target_document_id: auditPlan.targetDocumentId,
            target_document_title: documentLabel(targetDocument),
            affected_document_ids: [
              auditPlan.sourceDocumentId,
              auditPlan.targetDocumentId,
            ],
            relationship_type: auditPlan.relationshipType,
            relationship_label: getDocumentRelationshipLabel(auditPlan.relationshipType) ?? titleize(auditPlan.relationshipType),
            reason: auditPlan.reason,
            evidence_reference: auditPlan.evidenceReference,
          },
        });
      } else if (auditPlan.kind === 'delete_relationship') {
        const sourceDocument = documentById.get(auditPlan.sourceDocumentId)
          ?? previousDocumentById.get(auditPlan.sourceDocumentId)
          ?? null;
        const targetDocument = documentById.get(auditPlan.targetDocumentId)
          ?? previousDocumentById.get(auditPlan.targetDocumentId)
          ?? null;

        if (!duplicateAuditAlreadyLogged) await logTruthMutationActivity({
          organizationId: ctx.actor.organizationId,
          projectId,
          entityType: 'document',
          entityId: auditPlan.sourceDocumentId,
          eventType: 'document_relationship_changed',
          actorId: ctx.actor.actorId,
          oldValue: {
            relationship_id: auditPlan.relationshipId,
            source_document_id: auditPlan.sourceDocumentId,
            source_document_title: documentLabel(sourceDocument),
            target_document_id: auditPlan.targetDocumentId,
            target_document_title: documentLabel(targetDocument),
            affected_document_ids: [
              auditPlan.sourceDocumentId,
              auditPlan.targetDocumentId,
            ],
            relationship_type: auditPlan.relationshipType,
            relationship_label: getDocumentRelationshipLabel(auditPlan.relationshipType) ?? titleize(auditPlan.relationshipType),
            relationship_created_by: auditPlan.createdBy,
            relationship_created_at: auditPlan.createdAt,
          },
          newValue: {
            action: 'removed',
            reason: auditPlan.reason,
            evidence_reference: auditPlan.evidenceReference,
          },
        });
      } else if (auditPlan.kind === 'set_document_subtype') {
        const nextDocument = documentById.get(auditPlan.documentId)
          ?? previousDocumentById.get(auditPlan.documentId)
          ?? null;

        await logTruthMutationActivity({
          organizationId: ctx.actor.organizationId,
          projectId,
          entityType: 'document',
          entityId: auditPlan.documentId,
          eventType: 'document_subtype_updated',
          actorId: ctx.actor.actorId,
          oldValue: {
            document_id: auditPlan.documentId,
            document_title: documentLabel(nextDocument),
            document_subtype: auditPlan.previousDocumentSubtype,
          },
          newValue: {
            document_id: auditPlan.documentId,
            document_title: documentLabel(nextDocument),
            document_subtype: auditPlan.nextDocumentSubtype,
          },
        });
      }

      if (auditPlan.kind !== 'set_governing') {
        await logGoverningDocumentDiffs({
          organizationId: ctx.actor.organizationId,
          projectId,
          actorId: ctx.actor.actorId,
          previousFamilies: snapshot.families,
          nextFamilies: refreshed.families,
          previousDocumentById,
          nextDocumentById: documentById,
        });
      }
    }

    if (shouldRefreshValidator) {
      // Revalidation begins only after required duplicate-disposition audit
      // delivery succeeds, so a compensated mutation cannot publish transient
      // authority state.
      void requestDocumentPrecedenceRevalidation({
        projectId,
        actorId: ctx.actor.actorId,
      });
    }

    return NextResponse.json({
      ok: true,
      documents: refreshed.documents,
      relationships: refreshed.relationships,
      families: refreshed.families,
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'Failed to update document precedence',
      500,
    );
  }
}
