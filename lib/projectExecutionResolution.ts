export type ProjectExecutionResolutionAction = 'approve' | 'correct' | 'override';

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export async function executeProjectExecutionResolution(params: {
  executionItemId: string;
  action: ProjectExecutionResolutionAction;
  accessToken: string;
  reason?: string | null;
  fetcher?: FetchLike;
}): Promise<{
  response: Pick<Response, 'ok' | 'status' | 'json'>;
  successMessage: string;
}> {
  const { executionItemId, action, accessToken, reason = null, fetcher = fetch } = params;
  const response = await fetcher(`/api/execution-items/${executionItemId}/outcome`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      action,
      reason: reason?.trim() || null,
    }),
  });

  return {
    response,
    successMessage:
      action === 'approve'
        ? 'Execution item approved.'
        : action === 'correct'
          ? 'Execution item corrected.'
          : 'Execution item overridden.',
  };
}
