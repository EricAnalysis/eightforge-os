import type { SupabaseClient } from '@supabase/supabase-js';
import { hasProjectAdminRole } from '@/lib/projectAdmin';
import { isMissingProjectIdColumnError } from '@/lib/isMissingProjectIdColumnError';

export type ScopedProjectRow = {
  id: string;
  organization_id: string;
  name: string;
  code: string | null;
  status: string | null;
};

export type ScopedDocumentRow = {
  id: string;
  organization_id: string;
  title: string | null;
  name: string;
  project_id: string | null;
};

export type DocumentProjectMutationBlockers = {
  decisionCount: number;
  taskCount: number;
  relationshipCount: number;
  errors: string[];
};

export type ProjectDeletionBlockers = {
  documentCount: number;
  directDecisionCount: number;
  directTaskCount: number;
  relationshipCount: number;
  missingProjectIdColumns: boolean;
  errors: string[];
};

type CountResult = {
  count: number;
  error: { message?: string; code?: string } | null;
};

function isMissingDocumentRelationshipsTable(
  error: { message?: string; code?: string } | null | undefined,
): boolean {
  if (!error) return false;
  return error.code === '42P01' || (error.message ?? '').toLowerCase().includes('document_relationships');
}

export function requireProjectAdminRole(role: string | null | undefined):
  | { ok: true }
  | { ok: false; error: string; status: number } {
  if (hasProjectAdminRole(role)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: 'Only organization owners or admins can manage project assignments.',
    status: 403,
  };
}

export async function loadScopedProject(
  admin: SupabaseClient,
  params: { organizationId: string; projectId: string },
): Promise<ScopedProjectRow | null> {
  const { data, error } = await admin
    .from('projects')
    .select('id, organization_id, name, code, status')
    .eq('organization_id', params.organizationId)
    .eq('id', params.projectId)
    .maybeSingle();

  if (error || !data) return null;
  return data as ScopedProjectRow;
}

export async function loadScopedDocument(
  admin: SupabaseClient,
  params: { organizationId: string; documentId: string },
): Promise<ScopedDocumentRow | null> {
  const { data, error } = await admin
    .from('documents')
    .select('id, organization_id, title, name, project_id')
    .eq('organization_id', params.organizationId)
    .eq('id', params.documentId)
    .maybeSingle();

  if (error || !data) return null;
  return data as ScopedDocumentRow;
}

function coerceCount(value: number | null | undefined): number {
  return typeof value === 'number' ? value : 0;
}

async function countRows(
  admin: SupabaseClient,
  params: {
    table: 'documents' | 'decisions' | 'workflow_tasks' | 'document_relationships';
    organizationId: string;
    projectId?: string;
  },
): Promise<CountResult> {
  const query = admin
    .from(params.table)
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', params.organizationId);

  if (params.projectId) {
    query.eq('project_id', params.projectId);
  }

  const { count, error } = await query;
  if (params.table === 'document_relationships' && isMissingDocumentRelationshipsTable(error)) {
    return { count: 0, error: null };
  }
  return { count: coerceCount(count), error };
}

export async function getDocumentProjectMutationBlockers(
  admin: SupabaseClient,
  params: { organizationId: string; documentId: string },
): Promise<DocumentProjectMutationBlockers> {
  const errors: string[] = [];
  const decisionsResult = await admin
    .from('decisions')
    .select('id')
    .eq('organization_id', params.organizationId)
    .eq('document_id', params.documentId);
  if (decisionsResult.error) {
    errors.push(decisionsResult.error.message);
  }

  const decisionIds = new Set(
    ((decisionsResult.data ?? []) as Array<{ id: string | null }>).flatMap((row) =>
      typeof row.id === 'string' ? [row.id] : [],
    ),
  );

  const directTaskResult = await admin
    .from('workflow_tasks')
    .select('id')
    .eq('organization_id', params.organizationId)
    .eq('document_id', params.documentId);
  if (directTaskResult.error) {
    errors.push(directTaskResult.error.message);
  }

  const directTaskIds = new Set(
    ((directTaskResult.data ?? []) as Array<{ id: string | null }>).flatMap((row) =>
      typeof row.id === 'string' ? [row.id] : [],
    ),
  );

  if (decisionIds.size > 0) {
    const decisionTaskResult = await admin
      .from('workflow_tasks')
      .select('id')
      .eq('organization_id', params.organizationId)
      .in('decision_id', Array.from(decisionIds));
    if (decisionTaskResult.error) {
      errors.push(decisionTaskResult.error.message);
    }

    for (const row of (decisionTaskResult.data ?? []) as Array<{ id: string | null }>) {
      if (typeof row.id === 'string') {
        directTaskIds.add(row.id);
      }
    }
  }

  const relationshipResult = await admin
    .from('document_relationships')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', params.organizationId)
    .or(`source_document_id.eq.${params.documentId},target_document_id.eq.${params.documentId}`);
  if (relationshipResult.error && !isMissingDocumentRelationshipsTable(relationshipResult.error)) {
    errors.push(relationshipResult.error.message);
  }

  return {
    decisionCount: decisionIds.size,
    taskCount: directTaskIds.size,
    relationshipCount: isMissingDocumentRelationshipsTable(relationshipResult.error)
      ? 0
      : coerceCount(relationshipResult.count),
    errors,
  };
}

export async function getProjectDeletionBlockers(
  admin: SupabaseClient,
  params: { organizationId: string; projectId: string },
): Promise<ProjectDeletionBlockers> {
  const [documentsResult, relationshipsResult, decisionsResult, tasksResult] = await Promise.all([
    countRows(admin, {
      table: 'documents',
      organizationId: params.organizationId,
      projectId: params.projectId,
    }),
    countRows(admin, {
      table: 'document_relationships',
      organizationId: params.organizationId,
      projectId: params.projectId,
    }),
    countRows(admin, {
      table: 'decisions',
      organizationId: params.organizationId,
      projectId: params.projectId,
    }),
    countRows(admin, {
      table: 'workflow_tasks',
      organizationId: params.organizationId,
      projectId: params.projectId,
    }),
  ]);

  const missingProjectIdColumns =
    isMissingProjectIdColumnError(decisionsResult.error) ||
    isMissingProjectIdColumnError(tasksResult.error);
  const errors = [
    documentsResult.error?.message,
    relationshipsResult.error?.message,
    missingProjectIdColumns ? null : decisionsResult.error?.message,
    missingProjectIdColumns ? null : tasksResult.error?.message,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return {
    documentCount: documentsResult.count,
    directDecisionCount: missingProjectIdColumns ? 0 : decisionsResult.count,
    directTaskCount: missingProjectIdColumns ? 0 : tasksResult.count,
    relationshipCount: relationshipsResult.count,
    missingProjectIdColumns,
    errors,
  };
}
