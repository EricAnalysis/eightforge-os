import type { ProjectActivityEventRow } from '@/lib/projectOverview';

export type ActivityQueryClient = {
  from(table: 'activity_events'): {
    select(columns: string): ActivityQueryBuilder;
  };
};

export type ActivityQueryBuilder = {
  eq(column: string, value: string): ActivityQueryBuilder;
  is(column: string, value: null): ActivityQueryBuilder;
  in(column: string, values: string[]): ActivityQueryBuilder;
  order(column: string, options: { ascending: boolean }): ActivityQueryBuilder;
  limit(count: number): PromiseLike<{
    data: unknown[] | null;
    error: { message?: string | null } | null;
  }>;
};

export type ProjectActivityEventScope = {
  projectId: string;
  projectDecisionIds: Set<string>;
  projectTaskIds: Set<string>;
  projectDocumentIds: Set<string>;
  executionItemIds: Set<string>;
  executionFindingIds: Set<string>;
};

const ACTIVITY_EVENT_SELECT =
  'id, project_id, entity_type, entity_id, event_type, old_value, new_value, changed_by, created_at';

function sortedIds(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.length > 0))].sort();
}

export function projectActivityFallbackEntityIds(
  scope: ProjectActivityEventScope,
): string[] {
  return sortedIds([
    scope.projectId,
    ...scope.projectDecisionIds,
    ...scope.projectTaskIds,
    ...scope.projectDocumentIds,
    ...scope.executionItemIds,
    ...scope.executionFindingIds,
  ]);
}

export function filterProjectActivityEvents(
  events: ProjectActivityEventRow[],
  scope: ProjectActivityEventScope,
): ProjectActivityEventRow[] {
  return events.filter((event) => {
    if (event.project_id === scope.projectId) return true;
    if (event.entity_type === 'decision') return scope.projectDecisionIds.has(event.entity_id);
    if (event.entity_type === 'workflow_task') return scope.projectTaskIds.has(event.entity_id);
    if (event.entity_type === 'execution_item') return scope.executionItemIds.has(event.entity_id);
    if (event.entity_type === 'project_validation_finding') {
      return scope.executionFindingIds.has(event.entity_id);
    }
    if (event.entity_type === 'project') return event.entity_id === scope.projectId;
    if (event.entity_type === 'project_validation_run') return event.project_id === scope.projectId;
    if (event.entity_type === 'document') {
      if (scope.projectDocumentIds.has(event.entity_id)) return true;
      const oldProjectId = typeof event.old_value?.project_id === 'string'
        ? event.old_value.project_id
        : null;
      const newProjectId = typeof event.new_value?.project_id === 'string'
        ? event.new_value.project_id
        : null;
      return oldProjectId === scope.projectId || newProjectId === scope.projectId;
    }
    return false;
  });
}

export async function loadProjectActivityEvents(params: {
  client: ActivityQueryClient;
  organizationId: string;
  scope: ProjectActivityEventScope;
  limit?: number;
}): Promise<{
  data: ProjectActivityEventRow[];
  error: { message?: string | null } | null;
}> {
  const rowLimit = params.limit ?? 150;
  const fallbackEntityIds = projectActivityFallbackEntityIds(params.scope);

  // Project-scoped and null-project-id-fallback events are independent
  // queries (the fallback's entity IDs come from params.scope, not from the
  // project-scoped result), so they run concurrently.
  const [projectScopedResult, fallbackResult] = await Promise.all([
    params.client
      .from('activity_events')
      .select(ACTIVITY_EVENT_SELECT)
      .eq('organization_id', params.organizationId)
      .eq('project_id', params.scope.projectId)
      .order('created_at', { ascending: false })
      .limit(rowLimit),
    fallbackEntityIds.length > 0
      ? params.client
          .from('activity_events')
          .select(ACTIVITY_EVENT_SELECT)
          .eq('organization_id', params.organizationId)
          .is('project_id', null)
          .in('entity_id', fallbackEntityIds)
          .order('created_at', { ascending: false })
          .limit(rowLimit)
      : { data: [], error: null },
  ]);

  const rows = [
    ...((projectScopedResult.data ?? []) as ProjectActivityEventRow[]),
    ...((fallbackResult.data ?? []) as ProjectActivityEventRow[]),
  ];
  const deduped = new Map<string, ProjectActivityEventRow>();
  for (const row of rows) {
    deduped.set(row.id, row);
  }

  return {
    data: filterProjectActivityEvents([...deduped.values()], params.scope)
      .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
      .slice(0, rowLimit),
    error: projectScopedResult.error ?? fallbackResult.error,
  };
}
