import { NextResponse } from 'next/server';
import {
  AUTHORITY_STATUS_VALUES,
  DOCUMENT_RELATIONSHIP_TYPES,
  GOVERNING_DOCUMENT_FAMILIES,
  type AuthorityStatus,
  type DocumentRelationshipType,
  type GoverningDocumentFamily,
} from '@/lib/documentPrecedence';
import { getActorContext } from '@/lib/server/getActorContext';
import { loadProjectDocumentPrecedenceSnapshot } from '@/lib/server/documentPrecedence';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
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

async function persistManualFamilyOrder(params: {
  organizationId: string;
  orderedDocumentIds: string[];
}) {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false as const, error: 'Server not configured', status: 503 as const };

  for (const [index, documentId] of params.orderedDocumentIds.entries()) {
    const { error } = await admin
      .from('documents')
      .update({
        operator_override_precedence: true,
        precedence_rank: index,
      })
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
    const { error } = await admin
      .from('documents')
      .update({
        operator_override_precedence: false,
        precedence_rank: null,
      })
      .eq('id', documentId)
      .eq('organization_id', params.organizationId);

    if (error) {
      return { ok: false as const, error: error.message, status: 500 as const };
    }
  }

  return { ok: true as const };
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

  const snapshot = await loadProjectDocumentPrecedenceSnapshot(projectResult.admin, {
    organizationId: ctx.actor.organizationId,
    projectId,
  });

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

      const nextOrder = [documentId, ...orderedDocumentIds.filter((id) => id !== documentId)];
      const updateResult = await persistManualFamilyOrder({
        organizationId: ctx.actor.organizationId,
        orderedDocumentIds: nextOrder,
      });
      if (!updateResult.ok) return jsonError(updateResult.error, updateResult.status);
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
    } else if (action === 'set_authority_status') {
      const documentId = typeof body.documentId === 'string' ? body.documentId : null;
      const authorityStatus = body.authorityStatus;
      if (!documentId || !isValidAuthorityStatus(authorityStatus)) {
        return jsonError('documentId and authorityStatus are required', 400);
      }

      const projectDocument = snapshot.documents.find((document) => document.id === documentId);
      if (!projectDocument) return jsonError('Document not found', 404);

      const { error } = await projectResult.admin
        .from('documents')
        .update({
          authority_status: authorityStatus,
          operator_override_precedence: authorityStatus === 'superseded' ? false : projectDocument.operator_override_precedence ?? false,
          precedence_rank: authorityStatus === 'superseded' ? null : projectDocument.precedence_rank ?? null,
        })
        .eq('id', documentId)
        .eq('organization_id', ctx.actor.organizationId);

      if (error) return jsonError(error.message, 500);
    } else if (action === 'link_relationship') {
      const sourceDocumentId = typeof body.sourceDocumentId === 'string' ? body.sourceDocumentId : null;
      const targetDocumentId = typeof body.targetDocumentId === 'string' ? body.targetDocumentId : null;
      const relationshipType = body.relationshipType;

      if (!sourceDocumentId || !targetDocumentId || !isValidRelationshipType(relationshipType)) {
        return jsonError('sourceDocumentId, targetDocumentId, and relationshipType are required', 400);
      }
      if (sourceDocumentId === targetDocumentId) {
        return jsonError('A document cannot relate to itself', 400);
      }

      const documentIds = new Set(snapshot.documents.map((document) => document.id));
      if (!documentIds.has(sourceDocumentId) || !documentIds.has(targetDocumentId)) {
        return jsonError('Related documents must belong to the project', 400);
      }

      const { error } = await projectResult.admin
        .from('document_relationships')
        .upsert(
          {
            organization_id: ctx.actor.organizationId,
            project_id: projectId,
            source_document_id: sourceDocumentId,
            target_document_id: targetDocumentId,
            relationship_type: relationshipType,
            created_by: ctx.actor.actorId,
          },
          {
            onConflict: 'project_id,source_document_id,target_document_id,relationship_type',
          },
        );

      if (error) return jsonError(error.message, 500);
    } else {
      return jsonError('Unsupported action', 400);
    }

    const refreshed = await loadProjectDocumentPrecedenceSnapshot(projectResult.admin, {
      organizationId: ctx.actor.organizationId,
      projectId,
    });

    return NextResponse.json({
      ok: true,
      families: refreshed.families,
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'Failed to update document precedence',
      500,
    );
  }
}
