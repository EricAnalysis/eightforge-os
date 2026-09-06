import type { LinearCapabilityProjection } from '@/lib/linearCapabilityProjection';

export type LinearIssueIdentity = Readonly<{ id: string; identifier: string }>;
export type LinearClient = Readonly<{
  createIssue: (projection: LinearCapabilityProjection) => Promise<LinearIssueIdentity>;
  findProjectedIssueByIdempotencyKey: (idempotencyKey: string) => Promise<LinearIssueIdentity | null>;
}>;

type LinearClientConfiguration = Readonly<{
  apiKey: string;
  projectId: string;
  teamId: string;
  labelIdsByName: Readonly<Record<string, string>>;
  fetcher?: typeof fetch;
}>;

type GraphqlEnvelope = { data?: Record<string, unknown>; errors?: unknown };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function issueIdentity(value: unknown, expectedProjectId: string): LinearIssueIdentity | null {
  const issue = record(value);
  const project = record(issue?.project);
  return typeof issue?.id === 'string' && typeof issue.identifier === 'string'
    && project?.id === expectedProjectId
    ? { id: issue.id, identifier: issue.identifier } : null;
}

/** The sole server-only Linear adapter. Its returned object has exactly two operations. */
export function createLinearClient(configuration: LinearClientConfiguration): LinearClient {
  const fetcher = configuration.fetcher ?? fetch;
  async function graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetcher('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: configuration.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('linear_unavailable');
    const envelope = await response.json() as GraphqlEnvelope;
    if (envelope.errors || !record(envelope.data)) throw new Error('linear_response_invalid');
    return envelope.data!;
  }

  return Object.freeze({
    async createIssue(projection) {
      const labelIds = projection.labels.map((label) => configuration.labelIdsByName[label]);
      if (labelIds.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new Error('linear_labels_not_configured');
      }
      const data = await graphql(
        'mutation CreateProjectedIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier project { id } } } }',
        { input: { teamId: configuration.teamId, projectId: configuration.projectId,
          title: projection.title, description: projection.description, labelIds } },
      );
      const payload = record(data.issueCreate);
      const identity = payload?.success === true
        ? issueIdentity(payload.issue, configuration.projectId) : null;
      if (!identity) throw new Error('linear_response_invalid');
      return identity;
    },
    async findProjectedIssueByIdempotencyKey(idempotencyKey) {
      const data = await graphql(
        'query FindProjectedIssue($query: String!) { issueSearch(query: $query, first: 10) { nodes { id identifier project { id } } } }',
        { query: idempotencyKey },
      );
      const search = record(data.issueSearch);
      if (!Array.isArray(search?.nodes)) throw new Error('linear_response_invalid');
      const matches = search.nodes.flatMap((node) => {
        const identity = issueIdentity(node, configuration.projectId);
        return identity ? [identity] : [];
      });
      if (matches.length > 1) throw new Error('linear_projection_ambiguous');
      return matches[0] ?? null;
    },
  });
}

export function configuredLinearClient(): Readonly<{
  projectId: string;
  client: LinearClient;
}> | null {
  const apiKey = process.env.LINEAR_API_KEY;
  const projectId = process.env.LINEAR_PROJECT_ID;
  const teamId = process.env.LINEAR_TEAM_ID;
  let labelIdsByName: Record<string, string>;
  try { labelIdsByName = JSON.parse(process.env.LINEAR_LABEL_IDS_JSON ?? '') as Record<string, string>; }
  catch { return null; }
  if (!apiKey || !projectId || !teamId || !record(labelIdsByName)) return null;
  return { projectId, client: createLinearClient({ apiKey, projectId, teamId, labelIdsByName }) };
}
