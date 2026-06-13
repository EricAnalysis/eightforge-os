import { executeProjectQuery } from '@/lib/projectQuery/executeProjectQuery';
import type { ProjectQueryResult } from '@/lib/projectQuery/types';
import type { ProjectQueryContext } from '@/lib/projectQuery/executeProjectQuery';
import type { TruthQueryType, TruthResultPayload } from '@/lib/truthQuery';

async function fetchTruthPayload(
  projectId: string,
  type: TruthQueryType,
  value: string,
): Promise<TruthResultPayload | null> {
  const res = await fetch('/api/truth/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, type, value }),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body && typeof body === 'object' ? (body as TruthResultPayload) : null;
}

export async function runAskThisProjectQuery(args: {
  projectId: string;
  input: string;
  context?: ProjectQueryContext;
}): Promise<ProjectQueryResult> {
  return executeProjectQuery({
    projectId: args.projectId,
    input: args.input,
    context: args.context,
    queryTruth: fetchTruthPayload,
  });
}

export async function runAskThisProjectQueryWithLogging(args: {
  projectId: string;
  input: string;
  context?: ProjectQueryContext;
}): Promise<ProjectQueryResult> {
  const res = await runAskThisProjectQuery(args);
  void fetch('/api/project-query/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: args.projectId, query: args.input, trace: res.trace }),
  }).catch(() => null);
  return res;
}
